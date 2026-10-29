'use strict';

// M9-D630 — GET /v1/analytics/metrics/<código> dos dois KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const biSources = require('../_helpers/biSources');
const { leadsFromSource, firstResponseFromSource } = require('../_helpers/crmOracle630');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');
const { materializeCrmKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read'];
const at = (day, hh = 12, mm = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm)).toISOString();
const ids = [];
let env;
before(async () => {
  registry.clock.setClock(() => NOW);
  env = await http.setup();
  const t = env.tenantA;
  const broker = biSources.uuid();
  for (const [day, source, minutes] of [[5, 'PORTAL', 10], [6, 'PORTAL', 20], [7, 'SITE', 12], [8, 'SITE', 14], [9, 'INDICACAO', 14], [10, 'INDICACAO', null]]) {
    const id = await biSources.opportunity(env, t, { owner: broker, source, created: at(day, 10) });
    ids.push(id);
    if (minutes) await biSources.message(env, t, { opportunity: id, created: new Date(Date.parse(at(day, 10)) + minutes * 60000).toISOString() });
    const event = { id: biSources.uuid(), eventType: 'crm.opportunity.created', companyId: t.companyId, groupId: t.groupId, aggregateId: id, payloadJson: { id }, occurredAt: NOW, retryCount: 0 };
    await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW }));
  }
  await http.inTx(t, { commit: true }, (tx) => materializeCrmKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  registry.clock.resetClock();
  const c = { c: env.tenantA.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM crm.messages WHERE opportunity_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM crm.opportunities WHERE id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: c, transaction });
    await env.admin.query("DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code LIKE 'crm.%')", { replacements: c, transaction });
    await env.admin.query("UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code LIKE 'crm.%'", { replacements: c, transaction });
    await env.admin.query("DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code LIKE 'crm.%'", { replacements: c, transaction });
    for (const m of ['rm_crm_lead_daily', 'rm_crm_opportunity_stage', 'rm_crm_outcome', 'rm_crm_next_action']) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: c, transaction });
    await env.admin.query("DELETE FROM analytics.rm_applied_events WHERE company_id = :c", { replacements: c, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });

test('m9d630 GET /analytics/metrics/crm.leads_by_origin devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('crm.leads_by_origin');
  assert.equal(res.status, 200);
  const d = res.body.data;
  const want = await leadsFromSource(env, env.tenantA, AS_OF);
  assert.equal(Number(d.value), Number(want.total));
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode], ['COUNT', 'OK', 1, 'crm.leads_by_origin']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.equal(d.sourceRefs[0].table, 'crm.opportunities');
  assert.equal(d.sourceRefs[0].count, Number(want.total), 'o sourceRefs conta as mesmas oportunidades do valor');
  assert.equal(d.sourceRefs[0].restricted, true);
});

test('m9d630 GET /analytics/metrics/crm.first_response_time devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('crm.first_response_time');
  assert.equal(res.status, 200);
  const d = res.body.data;
  const want = await firstResponseFromSource(env, env.tenantA, AS_OF);
  assert.equal(want.average, '14.0');
  assert.equal(Number(d.value), Number(want.average));
  assert.deepEqual([d.unit, d.status, d.version], ['MINUTES', 'OK', 1]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt);
  assert.equal(d.sourceRefs[0].table, 'crm.opportunities');
});

test('m9d630 isolamento entre empresas no KPI', async () => { // 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece
  const res = await get('crm.leads_by_origin', { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
  assert.equal(res.status, 404);
  assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  const asB = await get('crm.leads_by_origin', { tenant: 'B' });
  assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador publicado nem o snapshot da A');
  const asBQuery = await env.call('GET', `/analytics/metrics/crm.leads_by_origin?asOf=${AS_OF}&companyId=${env.tenantA.companyId}`, { perms: READ, tenant: 'B' });
  assert.equal(asBQuery.status, 404, 'B pedindo a empresa A');
  assert.equal(asBQuery.body.code || asBQuery.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
});

test('m9d630 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('crm.leads_by_origin', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('crm.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('crm.first_response_time', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
