'use strict';

// Entrada robusta na API inteira pelo caminho HTTP real (login, JWT, tenant, RLS), verificação independente do Marco 9, rodada 7
// (`Maturacao/fechamento-m3-m6/verificacao/m9-rodada7.md`). Cada achado da rodada, nas rotas que a rodada citou:
//  1. `PUT /settings/<chave numérica>` com `value` aninhado fundo: 400, sem o valor em `details`, e a API segue respondendo (DI-M9R-18, DI-M9R-19);
//  2. tipo errado no corpo (objeto, lista ou número onde a rota espera texto ou id): 400 com o campo, nas rotas citadas (DI-M9R-21);
//  3. JSON aninhado fundo (corpo inteiro e campo, com e sem Idempotency-Key): 400 REQUEST_BODY_TOO_DEEP; número infinito: 400 (DI-M9R-18);
//  4. texto maior que a coluna: 400 com o campo, nunca o valor (DI-M9R-20, DI-M9R-21);
//  5. o mecanismo geral fora das rotas validadas: erro de dado do banco (classe 22) e erro de tipo com prova no pedido viram 400 (DI-M9R-20/21).
// Toda resposta é medida: nenhuma passa de 2 s. GRAVA de verdade: só em banco descartável (DISPOSABLE_DB=1) ou no CI, depois do seed de dois tenants.

process.env.PORT = process.env.ENTRADA_GLOBAL_HTTP_TEST_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const env = require('./marco9/_helpers/m9d230Env');
const { User, UserMembership, Role, Permission, RolePermission } = require('../src/models');

const SUFIXO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EMAIL = `ci-entrada-global-${SUFIXO}@ci.nayaraone.test`;
const TEMPOS = [];
let skipReason = null;
let A; let token; let pessoa;

function pedir(method, path, { corpo, semToken = false, headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = { 'Content-Type': 'application/json', ...(semToken ? {} : { Authorization: `Bearer ${token}` }), ...headers };
    const buf = corpo === undefined ? undefined : Buffer.from(corpo);
    if (buf) h['Content-Length'] = buf.length;
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), method, path: `/api/v1${path}`, headers: h }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (_e) { json = null; }
        const ms = Date.now() - t0; TEMPOS.push([`${method} ${path}`, ms]);
        resolve({ status: res.statusCode, json, ms });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('sem resposta em 20 s')));
    req.on('error', (e) => resolve({ status: 0, json: null, erro: e.message, ms: Date.now() - t0 }));
    if (buf) req.write(buf);
    req.end();
  });
}
const json = (o) => JSON.stringify(o);
const fundo = (n, tipo = 'obj') => (tipo === 'obj' ? `${'{"a":'.repeat(n)}1${'}'.repeat(n)}` : `${'['.repeat(n)}1${']'.repeat(n)}`);
const comCampo = (base, campo, cru) => json({ ...base, [campo]: '__X__' }).replace('"__X__"', cru);
const codigo = (r) => (r.json && r.json.error ? r.json.error.code : null);
const campos = (r) => (r.json && r.json.error && r.json.error.details ? r.json.error.details.fields : undefined);

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1' && !process.env.CI) { skipReason = 'Grava dados: só roda em banco descartável (scripts/withDisposableDb.js) ou no CI.'; return; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { skipReason = 'CI_TENANT_USERS_PASSWORD ausente (senha dos usuários fictícios do CI).'; return; }
  A = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await env.parametro(A, 'governanca.api.rate_limit.habilitado', false);
  const ps = await Permission.findAll();
  const user = await User.create({ name: 'CI entrada global', email: EMAIL, passwordHash: await bcrypt.hash(process.env.CI_TENANT_USERS_PASSWORD, 10), status: 'ACTIVE' });
  await env.comTenant(A, async (t) => {
    const role = await Role.create({ groupId: A.groupId, companyId: A.companyId, name: `CI ENTRADA GLOBAL ${SUFIXO}`, description: 'Perfil fictício do teste da entrada global (todas as permissões).', isSystem: false }, { transaction: t });
    for (const p of ps) await RolePermission.create({ roleId: role.id, permissionId: p.id }, { transaction: t });
    await UserMembership.create({ userId: user.id, groupId: A.groupId, companyId: A.companyId, roleId: role.id, status: 'ACTIVE' }, { transaction: t });
  });
  await new Promise((s) => setTimeout(s, 300));
  for (let i = 0; i < 5 && !token; i += 1) {
    const r = await pedir('POST', '/auth/login', { corpo: json({ email: EMAIL, password: process.env.CI_TENANT_USERS_PASSWORD, companyId: A.companyId }), semToken: true });
    if (r.status === 200) token = r.json.data.accessToken; else await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  assert.ok(token, 'login do usuário do teste');
  const p = await pedir('POST', '/people', { corpo: json({ personType: 'PF', legalName: `CI global ${SUFIXO}`, allowDuplicate: true }) });
  assert.equal(p.status, 201, json(p.json));
  pessoa = p.json.data.id;
});

after(async () => {
  if (A) await env.restaurar(A, ['governanca.api.rate_limit.habilitado']).catch(() => {});
  await env.sequelize.close().catch(() => {});
  process.exit(0); // a API deste processo segue ouvindo; o arquivo termina aqui, como os demais testes HTTP
});

const rodar = (nome, fn) => test(nome, async (t) => { if (skipReason) { t.skip(skipReason); return; } await fn(); });

rodar('1. PUT /settings com value aninhado fundo: 400 sem o valor, e a API continua respondendo', async () => {
  for (const chave of ['integration.messaging.inbound_lead_prazo_horas', 'integration.whatsapp.max_text_chars']) {
    for (const n of [5000, 50000]) {
      const r = await pedir('PUT', `/settings/${chave}`, { corpo: `{"value":${fundo(n)}}` });
      assert.deepEqual([r.status, codigo(r), campos(r)], [400, 'REQUEST_BODY_TOO_DEEP', ['value']], `${chave} ${n}: ${r.status} ${r.erro || ''}`);
    }
    // abaixo do limite de profundidade: a recusa da chave numérica leva só a chave, nunca o valor recebido
    const raso = await pedir('PUT', `/settings/${chave}`, { corpo: `{"value":${fundo(40)}}` });
    assert.deepEqual([raso.status, codigo(raso), raso.json.error.details], [400, 'SETTING_INVALID_VALUE', { key: chave }]);
  }
  const vivo = await pedir('GET', '/people');
  assert.equal(vivo.status, 200, 'a API segue atendendo');
});

rodar('2. tipo errado no corpo das rotas citadas: 400 com o nome do campo (antes: 500)', async () => {
  const errados = ['{"x":1}', '["a","b"]', '12345', '1e20', 'true'];
  for (const cru of errados) {
    const login = await pedir('POST', '/auth/login', { corpo: comCampo({ password: 'x'.repeat(12) }, 'email', cru), semToken: true });
    assert.deepEqual([login.status, codigo(login), campos(login)], [400, 'AUTH_VALIDATION', ['email']], `login email=${cru}`);
    const p = await pedir('POST', '/people', { corpo: comCampo({ legalName: `CI ${SUFIXO}`, allowDuplicate: true }, 'personType', cru) });
    assert.deepEqual([p.status, codigo(p), campos(p)], [400, 'PERSON_VALIDATION', ['personType']], `people personType=${cru}`);
    const o = await pedir('POST', '/opportunities', { corpo: comCampo({ nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 864e5).toISOString() }, 'personId', cru) });
    assert.deepEqual([o.status, codigo(o), campos(o)], [400, 'OPPORTUNITY_VALIDATION', ['personId']], `opportunities personId=${cru}`);
    const rd = await pedir('POST', '/radar', { corpo: comCampo({ criteriaJson: { required: { city: 'X' }, preferences: [] } }, 'personId', cru) });
    assert.deepEqual([rd.status, codigo(rd), campos(rd)], [400, 'RADAR_VALIDATION', ['personId']], `radar personId=${cru}`);
  }
  // data que não é data: o banco recusa (classe 22) e a resposta é 400, não 500
  const data = await pedir('POST', '/opportunities', { corpo: json({ personId: pessoa, nextAction: 'Ligar', nextActionDueAt: 'amanhã cedo' }) });
  assert.deepEqual([data.status, codigo(data)], [400, 'INVALID_DATE_VALUE']);
  // o caminho certo continua funcionando
  const ok = await pedir('POST', '/opportunities', { corpo: json({ personId: pessoa, nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 864e5).toISOString() }) });
  assert.equal(ok.status, 201, json(ok.json));
});

rodar('3. JSON aninhado fundo nas rotas citadas (com e sem Idempotency-Key) e número infinito: 400 na porta', async () => {
  const rotas = [
    ['POST', '/dlp/copy-events', { resourceType: 'finance.bank_account', resourceId: '9d3b6a0e-0000-4000-8000-000000000001', field: 'accountNumber', outcome: 'DENIED' }],
    ['POST', '/finance/entries', { entryType: 'DEBIT', nature: 'PAYABLE', amount: 12.5, description: `CI ${SUFIXO}` }],
    ['POST', '/files', { fileName: 'a.png', mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=', category: 'generic' }],
    ['POST', '/people', { personType: 'PF', legalName: `CI ${SUFIXO}`, allowDuplicate: true }],
    ['POST', '/opportunities', { personId: pessoa, nextAction: 'Ligar' }],
    ['POST', '/radar', { personId: pessoa, criteriaJson: { required: {}, preferences: [] } }],
  ];
  for (const [m, p, base] of rotas) {
    for (const n of [1000, 5000, 50000]) {
      for (const tipo of ['obj', 'arr']) {
        const idem = { 'Idempotency-Key': `ci-global-${SUFIXO}-${p}-${n}-${tipo}` };
        const inteiro = await pedir(m, p, { corpo: fundo(n, tipo), headers: idem });
        assert.deepEqual([inteiro.status, codigo(inteiro)], [400, 'REQUEST_BODY_TOO_DEEP'], `${p} corpo ${tipo} ${n}`);
        const campo = Object.keys(base)[0];
        const r = await pedir(m, p, { corpo: comCampo(base, campo, fundo(n, tipo)), headers: { 'Idempotency-Key': `${idem['Idempotency-Key']}-c` } });
        assert.deepEqual([r.status, codigo(r), campos(r)], [400, 'REQUEST_BODY_TOO_DEEP', [campo]], `${p} campo ${campo} ${tipo} ${n}`);
      }
    }
    const inf = await pedir(m, p, { corpo: comCampo(base, 'amount', '1e400') });
    assert.deepEqual([inf.status, codigo(inf), campos(inf)], [400, 'REQUEST_BODY_NUMBER_OUT_OF_RANGE', ['amount']], `${p} 1e400`);
  }
  // aninhamento legítimo (abaixo do limite) passa
  const raso = await pedir('POST', '/radar', { corpo: json({ personId: pessoa, criteriaJson: { required: { city: 'X' }, preferences: [], extra: JSON.parse(fundo(20)) } }) });
  assert.equal(raso.status, 201, json(raso.json));
});

rodar('4. texto maior que a coluna: 400 com o campo e sem o valor (antes: 500 value too long)', async () => {
  const casos = [
    ['POST', '/people', { personType: 'PF', legalName: 'L'.repeat(201), allowDuplicate: true }, 'PERSON_VALIDATION', 'legalName'],
    ['POST', '/people', { personType: 'PF', legalName: `CI ${SUFIXO}`, preferredName: 'P'.repeat(151), allowDuplicate: true }, 'PERSON_VALIDATION', 'preferredName'],
    ['PATCH', `/people/${pessoa}`, { preferredName: 'P'.repeat(151) }, 'PERSON_VALIDATION', 'preferredName'],
    ['POST', '/properties', { title: 'T'.repeat(256), internalCode: `CI-${SUFIXO}`, propertyType: 'RESIDENTIAL' }, 'PROPERTY_VALIDATION', 'title'],
    ['POST', '/properties', { title: `CI ${SUFIXO}`, internalCode: 'C'.repeat(41), propertyType: 'RESIDENTIAL' }, 'PROPERTY_VALIDATION', 'internalCode'],
  ];
  for (const [m, p, corpo, cod, campo] of casos) {
    const r = await pedir(m, p, { corpo: json(corpo) });
    assert.deepEqual([r.status, codigo(r), campos(r)], [400, cod, [campo]], `${m} ${p} ${campo}`);
    assert.ok(!JSON.stringify(r.json).includes('PPPPPPPPPP') && !JSON.stringify(r.json).includes('TTTTTTTTTT'), 'o valor não volta na resposta');
  }
  // o limite conta caracteres como o banco (um emoji é 1): 200 emojis cabem em legalName
  const emoji = await pedir('POST', '/people', { corpo: json({ personType: 'PF', legalName: '🙂'.repeat(200), allowDuplicate: true }) });
  assert.equal(emoji.status, 201, json(emoji.json));
});

rodar('nenhuma resposta passou de 2 s', async () => {
  const lentas = TEMPOS.filter(([, ms]) => ms >= 2000);
  assert.deepEqual(lentas, []);
});
