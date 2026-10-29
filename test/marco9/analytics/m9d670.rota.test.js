'use strict';

// M9-D670 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas;
// recusas; fuso de São Paulo (lançamento às 23:30 do último dia do mês) e replay do mesmo evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const kit = require('../_helpers/mktKpiEnv');
const sc = require('../_helpers/m9d670Scenario');
const oracle = require('../_helpers/m9d670Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { assertReplayIdempotent } = require('../_helpers/readModelAsserts');

const AS_OF = kit.AS_OF;
const READ = ['analytics:read', 'marketing:attribution:read']; // M9-D702: a rota de métrica confere também a permissão do domínio (M9-D700)
const CODES = ['mkt.campaigns', 'mkt.cost', 'mkt.leads', 'mkt.attribution'];
let env;
let ids;
before(async () => {
  env = await http.setup();
  env.created = [];
  kit.clock.setClock(kit.NOW);
  ids = await sc.bom(env, env.tenantA);
  await kit.refreshAll(env, env.tenantA);
  await kit.kpis(env.tenantA);
  kit.clock.setClock(new Date('2026-11-02T15:00:00Z'));
  await kit.kpis(env.tenantA, '2026-11-01');
  kit.clock.setClock(kit.NOW);
});
after(async () => {
  kit.clock.resetClock();
  const tenants = [env.tenantA.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...env.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:c) AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:c) AND metric_code IN (:codes))', { replacements: { c: tenants, codes: kit.CODES }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:c) AND metric_code IN (:codes))', { replacements: { c: tenants, codes: kit.CODES }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:c) AND metric_code IN (:codes)', { replacements: { c: tenants, codes: kit.CODES }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:c) AND metric_code IN (:codes)', { replacements: { c: tenants, codes: kit.CODES }, transaction });
    for (const m of kit.MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id IN (:c)`, { replacements: { c: tenants }, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:c)`, { replacements: { c: tenants }, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
/** A rota devolve o valor com a escala da coluna do snapshot (4 casas): compara pelo valor, não pelo texto. */
const same = (actual, expected, label) => assert.equal(money.cmp(actual, expected), 0, `${label || ''} ${actual} != ${expected}`);
const shape = (d, code, unit, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d670 GET /analytics/metrics/mkt.campaigns devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.campaigns')).body.data;
  assert.equal(Number(d.value), (await oracle.campaignsFromSource(env, env.tenantA, '2026-10')).active);
  shape(d, 'mkt.campaigns', 'COUNT', 'marketing.campaigns');
});

test('m9d670 GET /analytics/metrics/mkt.cost devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.cost')).body.data;
  same(d.value, oracle.money((await oracle.costFromSource(env, env.tenantA, '2026-10')).settled));
  shape(d, 'mkt.cost', 'BRL', 'finance.financial_entries');
});

test('m9d670 GET /analytics/metrics/mkt.leads devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.leads')).body.data;
  assert.equal(Number(d.value), (await oracle.leadsFromSource(env, env.tenantA, '2026-10')).total);
  shape(d, 'mkt.leads', 'COUNT', 'crm.opportunities');
});

test('m9d670 GET /analytics/metrics/mkt.attribution devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('mkt.attribution')).body.data;
  const cost = await oracle.costFromSource(env, env.tenantA, '2026-10');
  same(d.value, oracle.money(Math.round(cost.settled / 6)));
  shape(d, 'mkt.attribution', 'BRL', 'marketing.attribution_events');
});

test('m9d670 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d670 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('mkt.cost', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('mkt.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('mkt.cost', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d670 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  // 01/11 02:30Z = 31/10 23:30 em SP (outubro); 01/11 03:30Z = 01/11 00:30 em SP (novembro)
  const october = (await get('mkt.cost')).body.data;
  same(october.value, '3350.25', 'inclui os 1.199,90 das 23:30 de 31/10 e não inclui os 77,00 da 00:30 de 01/11');
  kit.clock.setClock(new Date('2026-11-02T15:00:00Z')); // a data-base de novembro só existe depois de novembro começar
  try {
    const november = (await get('mkt.cost', { query: 'asOf=2026-11-01' })).body.data;
    same(november.value, '77.00', 'o instante UTC já no dia seguinte pertence ao dia/mês de São Paulo');
  } finally { kit.clock.setClock(kit.NOW); }
});

test('m9d670 replay do mesmo evento não altera o valor', async () => {
  const t = env.tenantA;
  const readRows = async () => (await env.admin.query('SELECT * FROM analytics.rm_mkt_campaign_month WHERE company_id = :c ORDER BY campaign_id, month', { replacements: { c: t.companyId } }))[0];
  const before = await get('mkt.cost');
  const event = kit.makeEvent(t, 'attribution.recorded', { eventId: kit.uuid(), campaignId: ids.c1, eventType: 'LEAD_CREATED' });
  await assertReplayIdempotent({ applyEvent: () => kit.apply(t, event), readRow: readRows });
  await kit.kpis(t);
  const after = await get('mkt.cost');
  same(after.body.data.value, before.body.data.value);
});
