'use strict';

// M9-D680 — GET /v1/analytics/metrics/<código> dos seis KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas; recusas; detalhe (drill-down)
// do KPI CRITICAL tec.integration_errors reconciliando com o valor; replay do mesmo evento (helper compartilhado assertReplayIdempotent da M9-D607).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const kit = require('../_helpers/m9d680Env');
const oracle = require('../_helpers/m9d680Oracle');
const asserts = require('../_helpers/readModelAsserts');
const clock = require('../../../src/features/analytics/metrics/clock');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { assertReconciles } = require('../../../src/features/analytics/metrics/sourceRefs.reconcile');
const { materializeTechKpis } = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, CODES, MODELS } = { ...kit };
const PERMS = ['analytics:read', 'analytics:read:tech'];
let env;
let src;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  await env.admin.query('DELETE FROM analytics.tech_signal_log');
  const t = env.tenantA;
  await bi.setSetting(src, t, 'analytics.tec.sondas', 'API,DATABASE');
  await bi.setSetting(src, t, 'analytics.tec.intervalo_sonda_s', 3600);
  await kit.seedSources(src, t);
  await kit.hourlyProbes(src);
  await bi.runSchedule(t, bi.NOW);
  await http.inTx(t, { commit: true }, (tx) => materializeTechKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...src.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c)', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c', { replacements: ids, transaction });
    for (const m of MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: ids, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id = :c`, { replacements: ids, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'analytics.tec.%'", { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = PERMS, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, table) => {
  assert.deepEqual([d.unit, d.version, d.metricCode, d.valueNature], [unit, 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d680 GET /analytics/metrics/tec.availability devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('tec.availability')).body.data;
  const want = await oracle.availability(src, { asOf: AS_OF, now: bi.NOW, intervalS: 3600, probes: ['API', 'DATABASE'] });
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), Number(want.value));
  shape(d, 'tec.availability', 'PERCENT', 'analytics.rm_tech_availability');
});

test('m9d680 GET /analytics/metrics/tec.queues_dlq devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('tec.queues_dlq')).body.data;
  assert.equal(d.status, 'OK');
  assert.ok(Number(d.value) >= 5);
  shape(d, 'tec.queues_dlq', 'COUNT', 'integration.outbox_events');
});

test('m9d680 GET /analytics/metrics/tec.integration_errors devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('tec.integration_errors')).body.data;
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), Number((await oracle.integrations(src, env.tenantA, 60)).value));
  shape(d, 'tec.integration_errors', 'PERCENT', 'integration.provider_health');
});

test('m9d680 GET /analytics/metrics/tec.freshness devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('tec.freshness')).body.data;
  assert.equal(d.status, 'OK');
  assert.ok(Number(d.value) >= 2, 'os dois read models fictícios atrasados do cenário');
  shape(d, 'tec.freshness', 'COUNT', 'analytics.read_model_refreshes');
});

test('m9d680 GET /analytics/metrics/tec.auth_failures devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('tec.auth_failures')).body.data;
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), (await oracle.authFailures(src, env.tenantA, AS_OF)).total);
  shape(d, 'tec.auth_failures', 'COUNT', 'analytics.rm_tech_auth_failures');
});

test('m9d680 tec.blocked_events devolve 200 DEGRADED com valor nulo enquanto há evento bloqueado sem motivo (nunca número enganoso)', async () => {
  const d = (await get('tec.blocked_events')).body.data;
  assert.deepEqual([d.status, d.value], ['DEGRADED', null]);
  shape(d, 'tec.blocked_events', 'COUNT', 'analytics.rm_tech_blocked_events');
});

test('m9d680 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d680 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noRead = await get('tec.availability', { perms: [] });
  assert.equal(noRead.status, 403);
  assert.equal(noRead.body.code || noRead.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('tec.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('tec.availability', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d680 tec.integration_errors (CRITICAL) tem especificação de origem e detalhe paginado que reconcilia com o valor do KPI', async () => {
  const kpi = (await get('tec.integration_errors')).body.data;
  const ref = kpi.sourceRefs[0];
  await http.inTx(env.tenantA, {}, async (tx) => {
    const ctx = http.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'analytics:read:tech']);
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: 'tec.integration_errors', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(body.reconcileMode, 'RECOMPUTE');
    assert.equal(rows.length, 3, 'as três connections ativas na última janela de 60 minutos (a DRAFT e a janela antiga ficam de fora)');
    const r = await assertReconciles({ companyId: env.tenantA.companyId }, 'tec.integration_errors', ref, kpi.value, { unit: 'PERCENT' }, tx);
    assert.equal(r.ok, true);
  });
});

test('m9d680 replay do mesmo evento não altera o valor (assertReplayIdempotent sobre os read models dos KPIs)', async () => {
  const t = env.tenantA;
  const cases = [['integration.dispatch.failed', 'rm_tech_integrations'], ['automation.run.blocked', 'rm_tech_blocked_events']];
  for (const [type, model] of cases) {
    const event = bi.makeEvent(t, type, { id: bi.uuid() });
    const read = async () => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3, 4, 5`, { replacements: { c: t.companyId } }))[0];
    await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(t, event), readRow: read });
  }
  const before = (await get('tec.integration_errors')).body.data.value;
  await http.inTx(t, { commit: true }, (tx) => materializeTechKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  assert.equal((await get('tec.integration_errors')).body.data.value, before);
});
