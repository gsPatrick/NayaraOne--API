'use strict';

// M9-D671 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas;
// recusas; fuso de São Paulo (mensagem às 23:30 do último dia do mês) e replay do mesmo evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const kit = require('../_helpers/mktKpiEnv');
const sc = require('../_helpers/m9d671Scenario');
const oracle = require('../_helpers/m9d671Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { assertReplayIdempotent } = require('../_helpers/readModelAsserts');

const AS_OF = kit.AS_OF;
const READ = ['analytics:read', 'marketing:attribution:read']; // M9-D702: a rota de métrica confere também a permissão do domínio (M9-D700)
const CODES = ['mkt.deliverability', 'mkt.opt_out', 'mkt.frequency', 'mkt.automations_blocked_failed'];
let env;
before(async () => {
  env = await http.setup();
  env.created = [];
  kit.clock.setClock(kit.NOW);
  await sc.bom(env, env.tenantA, kit.src.uuid());
  await kit.refreshAll(env, env.tenantA);
  await kit.kpis(env.tenantA);
  kit.clock.setClock(new Date('2026-11-02T15:00:00Z'));
  await kit.kpis(env.tenantA, '2026-11-01');
  kit.clock.setClock(kit.NOW);
});
after(async () => {
  kit.clock.resetClock();
  const c = [env.tenantA.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...env.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:c) AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:c) AND metric_code IN (:codes))', { replacements: { c, codes: kit.CODES }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:c) AND metric_code IN (:codes))', { replacements: { c, codes: kit.CODES }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:c) AND metric_code IN (:codes)', { replacements: { c, codes: kit.CODES }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:c) AND metric_code IN (:codes)', { replacements: { c, codes: kit.CODES }, transaction });
    for (const m of kit.MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id IN (:c)`, { replacements: { c }, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:c)`, { replacements: { c }, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
/** A rota devolve o valor com a escala da coluna do snapshot (4 casas): compara pelo valor, não pelo texto. */
const same = (actual, expected) => assert.equal(money.cmp(actual, expected), 0, `${actual} != ${expected}`);
const shape = (d, code, unit, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d671 GET /analytics/metrics/mkt.deliverability devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.deliverability')).body.data;
  const want = await oracle.deliveryFromSource(env, env.tenantA, '2026-10');
  same(d.value, oracle.pct(want.delivered, want.sent));
  shape(d, 'mkt.deliverability', 'PERCENT', 'crm.messages');
});

test('m9d671 GET /analytics/metrics/mkt.opt_out devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.opt_out')).body.data;
  const want = await oracle.optOutFromSource(env, env.tenantA, '2026-10');
  same(d.value, oracle.pct(want.optOuts, want.reached));
  shape(d, 'mkt.opt_out', 'PERCENT', 'marketing.suppression_list');
});

test('m9d671 GET /analytics/metrics/mkt.frequency devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.frequency')).body.data;
  const want = await oracle.frequencyFromSource(env, env.tenantA, AS_OF, 7);
  same(d.value, (Math.round((want.messages * 100) / want.people) / 100).toFixed(2));
  shape(d, 'mkt.frequency', 'NUMBER', 'crm.messages');
});

test('m9d671 GET /analytics/metrics/mkt.automations_blocked_failed devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.automations_blocked_failed')).body.data;
  same(d.value, String((await oracle.automationsFromSource(env, env.tenantA, '2026-10')).total));
  shape(d, 'mkt.automations_blocked_failed', 'COUNT', 'marketing.automation_runs');
});

test('m9d671 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d671 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('mkt.opt_out', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('mkt.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('mkt.opt_out', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d671 timezone: mensagem às 23:30 de São Paulo cai no dia certo', async () => {
  // 01/11 02:30Z = 31/10 23:30 em SP (outubro, entregue); 01/11 03:30Z = 01/11 00:30 em SP (novembro, entregue)
  const november = await oracle.deliveryFromSource(env, env.tenantA, '2026-11');
  assert.deepEqual([november.sent, november.delivered], [1, 1], 'o instante UTC já no dia seguinte pertence ao mês de São Paulo');
  const october = await oracle.deliveryFromSource(env, env.tenantA, '2026-10');
  assert.equal(october.sent, 25, 'a das 23:30 de 31/10 está em outubro');
  kit.clock.setClock(new Date('2026-11-02T15:00:00Z')); // a data-base de novembro só existe depois de novembro começar
  try {
    const nov = (await get('mkt.deliverability', { query: 'asOf=2026-11-01' })).body.data;
    same(nov.value, '100.00');
    assert.equal(nov.status, 'OK');
  } finally { kit.clock.setClock(kit.NOW); }
});

test('m9d671 replay do mesmo evento não altera o valor', async () => {
  const t = env.tenantA;
  const readRows = async () => (await env.admin.query('SELECT * FROM analytics.rm_mkt_delivery WHERE company_id = :c ORDER BY day, channel', { replacements: { c: t.companyId } }))[0];
  const before = await get('mkt.deliverability');
  const event = kit.makeEvent(t, 'crm.message.status_changed', { id: kit.uuid(), channel: 'WHATSAPP', status: 'DELIVERED', day: '2026-10-21' });
  await assertReplayIdempotent({ applyEvent: () => kit.apply(t, event), readRow: readRows });
  await kit.kpis(t);
  same((await get('mkt.deliverability')).body.data.value, before.body.data.value);
});
