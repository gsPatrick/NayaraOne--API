'use strict';

// M9-D625 — segurança e integridade do consolidado: permissão de grupo, grupo alheio (404), só as empresas permitidas (com aviso), leitura pura
// (nenhuma linha consolidada no ledger) e o caixa do Financeiro (a transferência liquidada não muda a soma).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e625 = require('../_helpers/m9d625Env');
const e620 = require('../_helpers/m9d620Env');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const readModels = require('../../../src/features/analytics/read-models');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');

const { CODES } = e625;
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
let env;
before(async () => {
  env = await e625.setup();
  await e625.snapshot(env, env.cX, CODES.revenue, '80000.00');
  await e625.snapshot(env, env.cY, CODES.revenue, '50000.00');
});
after(() => e625.teardown(env));

test('m9d625 usuário de empresa sem permissão de grupo recebe 403', async () => {
  const res = await e625.get(env, CODES.revenue, { perms: ['analytics:read'] });
  assert.equal(res.status, 403);
  assert.equal(code(res), 'ANALYTICS_GROUP_SCOPE_FORBIDDEN');
  assert.equal(res.body.message || res.body.error.message, 'Você não tem permissão para ver o consolidado do grupo.');
});

test('m9d625 grupo sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND, nunca 403', async () => {
  const other = await e625.get(env, CODES.revenue, { tenant: 'B', groupId: env.tenantA.groupId, perms: e625.GROUP_PERMS });
  assert.equal(other.status, 404);
  assert.equal(code(other), 'ANALYTICS_SCOPE_NOT_FOUND');
  const noPerm = await e625.get(env, CODES.revenue, { tenant: 'B', groupId: env.tenantA.groupId, perms: ['analytics:read'] });
  assert.equal(noPerm.status, 404, 'quem não tem vínculo nunca descobre se o grupo existe, tenha ou não a permissão');
  for (const groupId of ['nao-e-uuid', '00000000-0000-0000-0000-000000000000']) {
    const res = await e625.get(env, CODES.revenue, { groupId });
    assert.equal(res.status, 404, groupId);
    assert.equal(code(res), 'ANALYTICS_SCOPE_NOT_FOUND');
  }
});

test('m9d625 usuário vê consolidado só das empresas permitidas e com aviso', async () => {
  const res = await e625.get(env, CODES.revenue);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  const ids = d.byCompany.map((c) => c.companyId).sort();
  assert.deepEqual(ids, [env.cX.companyId, env.cY.companyId].sort(), 'Z (sem vínculo) e a empresa da sessão (sem finance:read) ficam de fora');
  assert.equal(money.money(d.value), '130000.00');
  assert.equal(d.warnings[0].code, 'ANALYTICS_CONSOLIDATED_PARTIAL');
  assert.equal(d.warnings[0].message, 'Consolidado só das empresas permitidas.');
  assert.ok(d.details.companiesIncluded < d.details.companiesInGroup);
  assert.ok(!JSON.stringify(d).includes(env.cZ.companyId), 'nada da empresa que o usuário não alcança');
  const w = await e625.newCompany(env, 'Papel sem Financeiro', { permissions: ['analytics:read'] });
  assert.ok(w.companyId);
  const again = await e625.get(env, CODES.revenue);
  assert.ok(!again.body.data.byCompany.some((c) => c.companyId === w.companyId), 'vínculo sem a permissão da área do indicador também fica de fora');
});

test('m9d625 recusas de indicador: inexistente 404, que não se soma 422', async () => {
  const missing = await e625.get(env, 'fin.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(code(missing), 'ANALYTICS_METRIC_NOT_FOUND');
  await e625.snapshot(env, env.cX, CODES.cost, '1.00');
  const { registerConsolidationRule, unregisterConsolidationRule } = require('../../../src/features/analytics/metrics/consolidation/rules');
  unregisterConsolidationRule(CODES.cost);
  registerConsolidationRule(CODES.cost, { kind: 'NONE', reason: 'teste' });
  const none = await e625.get(env, CODES.cost);
  assert.equal(none.status, 422);
  assert.equal(code(none), 'ANALYTICS_METRIC_NOT_CONSOLIDATABLE');
  const composite = await e625.get(env, 'fin.breathing_need');
  assert.ok([404, 422].includes(composite.status), 'indicador composto não se soma entre empresas');
});

test('m9d625 ledger não recebe linha consolidada', async () => {
  const count = async () => (await env.admin.query(`SELECT (SELECT count(*) FROM finance.financial_entries) AS entries, (SELECT count(*) FROM analytics.metric_snapshots) AS snapshots,
     (SELECT count(*) FROM analytics.metric_snapshots WHERE scope_type <> 'COMPANY') AS non_company, (SELECT count(*) FROM analytics.metric_definitions) AS definitions`))[0][0];
  const before625 = await count();
  const res = await e625.get(env, CODES.revenue);
  assert.equal(res.status, 200);
  assert.deepEqual(await count(), before625, 'ler o consolidado não grava nada: nem lançamento, nem snapshot, nem definição');
  assert.equal(before625.non_company, '0', 'nenhum snapshot de escopo diferente de empresa');
  const dir = path.join(__dirname, '..', '..', '..', 'src', 'features', 'analytics', 'metrics');
  for (const file of ['consolidation.service.js', ...fs.readdirSync(path.join(dir, 'consolidation')).map((f) => `consolidation/${f}`)]) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /\b(INSERT\s+INTO|UPDATE\s+\w+\.|DELETE\s+FROM|recordSnapshot|\.create\(|\.save\()/i, `${file} só lê`);
  }
});

test('m9d625 caixa do Financeiro: soma das empresas, a transferência liquidada sai de uma conta e entra na outra', async () => {
  const [x, y] = [env.cX, env.cY];
  await e620.ledger.insert({ admin: env.admin, created: env.src.created }, 'financial_entries', x, {
    entry_type: 'CREDIT', nature: 'RECEIVABLE', amount: '1000.00', status: 'SETTLED', settled_at: '2026-10-27T15:00:00.000Z', result_center_id: null });
  await e625.transfer(env, x, y, { amount: '250.00' });
  for (const t of [x, y]) {
    const event = e620.event(t, 'finance.entry.settled');
    await e625.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: e620.NOW }));
    await e625.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, e625.AS_OF, tx));
  }
  await e625.refreshPairs(x);
  const res = await e625.get(env, 'fin.free_cash');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.deepEqual(d.byCompany.map((c) => money.money(c.value)).sort(), ['250.00', '750.00'], 'X: 1.000 - 250; Y: +250');
  assert.equal(money.money(d.value), '1000.00', 'o caixa consolidado é a soma dos caixas das empresas e a transferência não o altera');
  assert.equal(d.eliminations, '0.00');
  assert.equal(d.consolidatedStatus, 'OK');
});

test('m9d625 sem nenhuma empresa alcançável para a área do indicador: 403 PERMISSION_DENIED com a permissão da área', async () => {
  const res = await e625.get(env, 'fin.free_cash', { tenant: 'B', groupId: env.tenantB.groupId, perms: e625.GROUP_PERMS });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(code(res), 'PERMISSION_DENIED');
  assert.match(res.body.message || res.body.error.message, /finance:read/);
});
