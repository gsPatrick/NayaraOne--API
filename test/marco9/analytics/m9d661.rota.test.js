'use strict';

// M9-D661 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre
// empresas; recusas; detalhe (drill-down) do KPI CRITICAL cor.commission cuja soma bate com o valor.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d661Scenario');
const oracle = require('../_helpers/m9d661Oracle');
const registry = require('../../../src/features/analytics/metrics');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { materializeCorrespondentKpis } = require('../../../src/features/analytics/metrics/kpis');
const clock = require('../../../src/features/analytics/metrics/clock');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const AS_OF = bi.AS_OF;
const READ = ['analytics:read'];
const CODES = ['cor.cases_by_stage', 'cor.approval_rate_by_provider', 'cor.analysis_time', 'cor.commission'];
const MODELS = ['rm_fin_cases_stage', 'rm_fin_provider_outcome', 'rm_fin_commission'];
let env;
let src;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  const cases = await sc.casos(src, t);
  await sc.comissoes(src, t, cases.decided[0]);
  for (const [type, payload] of [['financing.status.changed', {}], ['commission.confirmed', {}], ...cases.decided.map((id) => ['financing.approved', { id }])]) await bi.apply(t, bi.makeEvent(t, type, { id: bi.uuid(), ...payload }));
  await http.inTx(t, { commit: true }, (tx) => materializeCorrespondentKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId, codes: CODES };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...src.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes))', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes))', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code IN (:codes)', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes)', { replacements: ids, transaction });
    for (const m of MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, nature, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, nature]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d661 GET /analytics/metrics/cor.cases_by_stage devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('cor.cases_by_stage')).body.data;
  const want = await oracle.stagesFromSource(src, env.tenantA, AS_OF);
  assert.equal(Number(d.value), Object.values(want).reduce((a, v) => a + v.count, 0));
  shape(d, 'cor.cases_by_stage', 'COUNT', 'ACTUAL', 'correspondent.financing_cases');
});

test('m9d661 GET /analytics/metrics/cor.approval_rate_by_provider devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('cor.approval_rate_by_provider')).body.data;
  assert.equal(Number(d.value), (await oracle.decisionsFromSource(src, env.tenantA, '2026-10')).total);
  shape(d, 'cor.approval_rate_by_provider', 'COUNT', 'ACTUAL', 'correspondent.provider_status_history');
});

test('m9d661 GET /analytics/metrics/cor.analysis_time devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('cor.analysis_time')).body.data;
  const want = await oracle.decisionsFromSource(src, env.tenantA, '2026-10');
  assert.equal(money.cmp(d.value, money.round(money.div(want.days, want.analysed), 1)), 0);
  shape(d, 'cor.analysis_time', 'DAYS', 'ACTUAL', 'correspondent.provider_status_history');
});

test('m9d661 GET /analytics/metrics/cor.commission devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('cor.commission')).body.data;
  assert.equal(money.cmp(d.value, (await oracle.commissionFromSource(src, env.tenantA)).expected), 0);
  shape(d, 'cor.commission', 'BRL', 'ESTIMATED', 'correspondent.commission_entitlements');
});

test('m9d661 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d661 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('cor.commission', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('cor.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('cor.commission', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d661 cor.commission (CRITICAL) tem especificação de origem e detalhe paginado cuja soma bate com o valor do KPI', async () => {
  assert.ok(registry.getSourceSpec('cor.commission'), 'origem registrada');
  const kpi = (await get('cor.commission')).body.data;
  const ref = kpi.sourceRefs[0];
  await http.inTx(env.tenantA, {}, async (tx) => {
    const ctx = http.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'correspondent:read']);
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: 'cor.commission', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 1, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(body.reconcileMode, 'SUM');
    assert.equal(rows.length, 2);
    assert.equal(money.cmp(money.sum(rows.map((r) => r.contribution)), kpi.value), 0);
  });
});
