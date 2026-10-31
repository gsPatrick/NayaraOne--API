'use strict';

// M9-D825 — VIEW na API real (banco descartável): campo RESTRICTED mascarado sem a permissão dedicada, em claro com ela (e auditado), falha fechada, sinais de acesso e
// isolamento. Rodar: node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 <arquivo>"
process.env.PORT = process.env.M9D825_HTTP_TEST_PORT || '21825';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d825Env');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');

let http; let fx; let fxB;
before(async () => {
  http = await env.startDlpHttp(process.env.PORT);
  if (http.skip) return;
  fx = await env.createFixtures(http, 'gestorA', 'A');
  fxB = await env.createFixtures(http, 'gestorB', 'B');
});
after(async () => {
  if (fx) await env.removeFixtures(fx);
  if (fxB) await env.removeFixtures(fxB);
  await env.stopDlpHttp();
});
const signals = (tenant, userId) => env.adminQuery('SELECT kind, classification, outcome, count FROM governance.access_signals WHERE company_id = $1 AND user_id = $2 ORDER BY occurred_at', [tenant.companyId, userId]).then((r) => r.rows);

test('m9d825 VIEW de RESTRICTED sem permissão dedicada devolve o campo mascarado', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const res = await http.call('makerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const account = res.body.data;
  assert.match(account.accountNumber, /^\*{4}.{4}$/, 'conta mascarada com os 4 últimos caracteres');
  assert.notEqual(account.accountNumber, env.ACCOUNT);
  assert.equal(account.pixKey, '••••••', 'a chave PIX também (máscara total do registro de classificação, M9-D915)');
  assert.equal(account.agency, '0001', 'HIGH segue em claro (com auditoria)');
  assert.equal(account.bankCode, '••••••', 'bank_code é RESTRICTED no registro (palavra bank, M9-D910): sem a permissão sai mascarado');
  assert.ok(account.status && account.status !== '••••••', 'MEDIUM segue como está');
  const list = await http.call('makerA', 'GET', '/finance/bank-accounts');
  const row = list.body.data.find((item) => item.id === fx.accountId);
  assert.match(row.accountNumber, /^\*{4}/, 'a lista também sai mascarada');
  assert.ok(!JSON.stringify(list.body).includes(env.ACCOUNT), 'o número da conta não aparece em nenhum lugar da lista');
  const person = await http.call('gestorA', 'GET', `/people/${fx.personId}`);
  assert.equal(person.status, 200, JSON.stringify(person.body));
  assert.equal(person.body.data.taxIdNormalized, '***.***.***-25', 'CPF RESTRICTED mascarado pelo registro (só os 2 últimos dígitos) para quem não tem a permissão dedicada');
  assert.ok(!JSON.stringify(person.body).includes(env.CPF));
});

test('m9d825 RESTRICTED em claro só com a permissão dedicada e com auditoria', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const res = await http.call('checkerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accountNumber, env.ACCOUNT, 'com governance:dlp:view-restricted o valor sai em claro');
  const rows = (await env.adminQuery("SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp.view' AND entity_type = 'finance.bank_account' AND entity_id = $2 ORDER BY occurred_at DESC", [http.tenants.A.companyId, fx.accountId])).rows;
  assert.ok(rows.length >= 1, 'auditoria dlp.view do recurso');
  assert.equal(rows[0].user_id, (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-checker@ci.nayaraone.test'")).rows[0].id);
  assert.ok(rows.some((row) => row.after_json.classification === 'RESTRICTED'), 'a leitura de RESTRICTED em claro está registrada (HIGH do registro também gera linha)');
  assert.ok(!JSON.stringify(rows).includes(env.ACCOUNT), 'a auditoria nunca guarda o valor');
  const before = (await env.adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp.view' AND entity_id = $2", [http.tenants.A.companyId, fx.accountId])).rows[0].n;
  await http.call('checkerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  const after = (await env.adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.dlp.view' AND entity_id = $2", [http.tenants.A.companyId, fx.accountId])).rows[0].n;
  assert.equal(after, before, 'uma linha por recurso e por minuto: a segunda leitura no mesmo minuto não grava de novo');
});

test('m9d825 nenhuma rota aceita parâmetro que desligue a máscara', async (t) => {
  if (http.skip) return t.skip(http.skip);
  for (const query of ['raw=true', 'mask=false', 'unmask=1', 'reveal=true', 'plain=1', 'clear=true', 'includeSensitive=true', 'dlp=off', 'showRestricted=true']) {
    const res = await http.call('makerA', 'GET', `/finance/bank-accounts/${fx.accountId}?${query}`, undefined, { 'X-Dlp-Bypass': '1', 'X-Raw': 'true' });
    assert.match(res.body.data.accountNumber, /^\*{4}/, `?${query}`);
  }
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..', '..', 'src', 'features');
  const pattern = /req\.(query|headers)\.?\[?['"]?(raw|unmask|reveal|plain|clear|showRestricted|includeSensitive|x-dlp-bypass)\b/i;
  const offenders = [];
  for (const dir of ['people', 'properties', 'procurement', 'legal', 'finance', 'files']) {
    for (const file of fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.js'))) {
      if (pattern.test(fs.readFileSync(path.join(root, dir, file), 'utf8'))) offenders.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(offenders, [], 'varredura de parâmetros: nenhum controller lê um parâmetro de máscara');
});

test('m9d825 falha da política mascara RESTRICTED e libera LOW com alerta', async (t) => {
  if (http.skip) return t.skip(http.skip);
  resolver.setResolver(async () => { throw new Error('registro de classificação fora do ar'); });
  try {
    const res = await http.call('checkerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
    assert.equal(res.status, 200, 'a resposta sai, mas sem o dado sensível');
    assert.equal(res.body.data.accountNumber, '********', 'RESTRICTED mascarado por falha fechada, mesmo com a permissão dedicada');
    assert.equal(res.body.data.agency, '********', 'HIGH também falha fechado');
    assert.equal(res.body.data.bankCode, '********', 'bank_code é RESTRICTED no registro (M9-D910): falha fechada também o mascara');
    assert.ok(res.body.data.status !== '********', 'MEDIUM segue liberado');
    assert.ok(!JSON.stringify(res.body).includes(env.ACCOUNT));
  } finally { resolver.resetResolver(); }
  const ok = await http.call('checkerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(ok.body.data.accountNumber, env.ACCOUNT, 'a política voltou');
});

test('m9d825 cópias e leituras de RESTRICTED contam como sinais de anomalia', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const maker = (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-maker@ci.nayaraone.test'")).rows[0].id;
  await http.call('makerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  const rows = await signals(http.tenants.A, maker);
  assert.ok(rows.some((r) => r.kind === 'READ' && r.classification === 'RESTRICTED' && r.outcome === 'DENIED'), 'leitura de RESTRICTED mascarada vira sinal READ negado');
  assert.ok(rows.some((r) => r.kind === 'READ' && r.classification === 'HIGH' && r.outcome === 'ALLOWED'), 'leitura de HIGH vira sinal READ permitido');
  const checker = (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-checker@ci.nayaraone.test'")).rows[0].id;
  await http.call('checkerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.ok((await signals(http.tenants.A, checker)).some((r) => r.classification === 'RESTRICTED' && r.outcome === 'ALLOWED'), 'RESTRICTED em claro também conta');
});

test('m9d825 leitura de HIGH gera sinal de acesso', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const res = await http.call('gestorA', 'GET', `/people/${fx.personId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.birthOrFoundationDate.slice(0, 10), '1990-05-17', 'HIGH em claro para quem pode ler a pessoa');
  const rows = await signals(http.tenants.A, http.tenants.A.userId);
  assert.ok(rows.some((r) => r.kind === 'READ' && r.classification === 'HIGH' && r.outcome === 'ALLOWED' && r.count >= 1), JSON.stringify(rows));
});

test('m9d825 isolamento entre empresas', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const cross = await http.call('gestorB', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(cross.status, 404, 'a empresa B não enxerga a conta de A');
  const own = await http.call('gestorB', 'GET', `/people/${fxB.personId}`);
  assert.equal(own.status, 200);
  assert.equal((await signals(http.tenants.A, http.tenants.A.userId)).length, 0, 'a leitura de B não gera sinal em A');
  assert.ok((await signals(http.tenants.B, http.tenants.B.userId)).length >= 1, 'o sinal é de B');
  const audits = (await env.adminQuery("SELECT company_id FROM audit.audit_log WHERE action = 'governance.dlp.view' AND entity_id = $1", [fxB.personId])).rows;
  assert.ok(audits.length >= 1 && audits.every((a) => a.company_id === http.tenants.B.companyId), 'a auditoria é da empresa B');
});

test('m9d825 sem login a resposta não passa pela política e o módulo desligado não mascara', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const anon = await fetch(`${http.baseUrl}/finance/bank-accounts/${fx.accountId}`);
  assert.equal(anon.status, 401);
  await env.adminQuery("INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'governanca.modulos.dlp.habilitado', 'false'::jsonb, now(), now()) ON CONFLICT (company_id, key) DO UPDATE SET value = 'false'::jsonb", [http.tenants.A.groupId, http.tenants.A.companyId]);
  try {
    const res = await http.call('makerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
    assert.equal(res.body.data.accountNumber, env.ACCOUNT, 'DLP desligado pelo administrador: a resposta segue como está');
  } finally {
    await env.adminQuery("DELETE FROM core.tenant_settings WHERE key = 'governanca.modulos.dlp.habilitado'");
  }
});
