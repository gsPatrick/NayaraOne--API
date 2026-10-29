'use strict';

// M9-D631 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, o detalhe do
// indicador CRITICAL e as recusas. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const biSources = require('../_helpers/biSources');
const { outcomesFromSource, portfolioFromSource, stagesFromSource } = require('../_helpers/crmOracle631');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');
const { materializeCrmKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read'];
const at = (day, hh = 12) => new Date(Date.UTC(2026, 9, day, hh + 3)).toISOString();
const ids = [];
let env;

async function insertOpp(t, c) {
  const id = await biSources.insert(env, 'crm.opportunities', t, {
    person_id: biSources.uuid(), owner_user_id: c.owner, stage: c.stage, closed_at: c.closedAt || null, lost_reason: c.lostReason || null, next_action: c.nextAction || null,
    next_action_due_at: c.nextActionDueAt || null, created_at: at(2), updated_at: c.updated || at(20),
  });
  ids.push(id);
  const event = { id: biSources.uuid(), eventType: c.closedAt ? `crm.opportunity.${c.stage === 'CLOSED_WON' ? 'won' : 'lost'}` : 'crm.opportunity.created', companyId: t.companyId, groupId: t.groupId, aggregateId: id, payloadJson: { id }, occurredAt: NOW, retryCount: 0 };
  await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW }));
}

before(async () => {
  registry.clock.setClock(() => NOW);
  env = await http.setup();
  const t = env.tenantA;
  const broker = biSources.uuid();
  for (let i = 0; i < 4; i += 1) await insertOpp(t, { owner: broker, stage: 'NEW', nextAction: 'Ligar', nextActionDueAt: '2026-11-05T15:00:00Z' });
  for (let i = 0; i < 2; i += 1) await insertOpp(t, { owner: broker, stage: 'VISIT_SCHEDULED' });
  for (let i = 0; i < 4; i += 1) await insertOpp(t, { owner: broker, stage: 'CLOSED_WON', closedAt: at(10 + i) });
  for (let i = 0; i < 4; i += 1) await insertOpp(t, { owner: broker, stage: 'CLOSED_LOST', closedAt: at(14 + i), lostReason: i < 3 ? 'PRICE' : 'CLIENT_GAVE_UP' });
  await http.inTx(t, { commit: true }, (tx) => materializeCrmKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  registry.clock.resetClock();
  const c = { c: env.tenantA.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM crm.opportunities WHERE id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: c, transaction });
    await env.admin.query("DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code LIKE 'crm.%')", { replacements: c, transaction });
    await env.admin.query("UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code LIKE 'crm.%'", { replacements: c, transaction });
    await env.admin.query("DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code LIKE 'crm.%'", { replacements: c, transaction });
    for (const m of ['rm_crm_lead_daily', 'rm_crm_opportunity_stage', 'rm_crm_outcome', 'rm_crm_next_action']) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: c, transaction });
    await env.admin.query('DELETE FROM analytics.rm_applied_events WHERE company_id = :c', { replacements: c, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const common = (d, code, unit) => {
  assert.deepEqual([d.unit, d.version, d.metricCode], [unit, 1, code]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.equal(d.sourceRefs[0].table, 'crm.opportunities');
};

test('m9d631 GET /analytics/metrics/crm.opportunities_by_stage devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('crm.opportunities_by_stage');
  assert.equal(res.status, 200);
  const want = await stagesFromSource(env, env.tenantA, AS_OF);
  assert.equal(Number(res.body.data.value), Number(want.total));
  assert.equal(res.body.data.status, 'OK');
  common(res.body.data, 'crm.opportunities_by_stage', 'COUNT');
  assert.equal(res.body.data.sourceRefs[0].count, Number(want.total));
});

test('m9d631 GET /analytics/metrics/crm.conversion_rate devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('crm.conversion_rate');
  assert.equal(res.status, 200);
  const want = await outcomesFromSource(env, env.tenantA, AS_OF);
  assert.deepEqual([want.won, want.lost, want.conversion], [4, 4, '50.00']);
  assert.equal(Number(res.body.data.value), 50);
  assert.equal(res.body.data.status, 'OK');
  common(res.body.data, 'crm.conversion_rate', 'PERCENT');
});

test('m9d631 GET /analytics/metrics/crm.loss_reasons devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('crm.loss_reasons');
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.data.value), 4);
  assert.equal(res.body.data.status, 'OK', '4 perdidas, todas com motivo');
  common(res.body.data, 'crm.loss_reasons', 'COUNT');
});

test('m9d631 GET /analytics/metrics/crm.portfolio_without_next_action devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('crm.portfolio_without_next_action');
  assert.equal(res.status, 200);
  const want = await portfolioFromSource(env, env.tenantA, '2026-10-29T03:00:00.000Z');
  assert.deepEqual([want.open, want.without], ['6', '2']);
  assert.equal(Number(res.body.data.value), 2);
  assert.equal(res.body.data.status, 'OK');
  common(res.body.data, 'crm.portfolio_without_next_action', 'COUNT');
  assert.equal(res.body.data.sourceRefs[0].count, 2);
});

test('m9d631 o detalhe HTTP do indicador CRITICAL devolve as oportunidades contadas e recusa quem não tem a permissão de detalhe', async () => {
  const kpi = (await get('crm.opportunities_by_stage')).body.data;
  const ref = kpi.sourceRefs[0];
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, pageSize: '50' }).toString();
  const ok = await env.call('GET', `/analytics/metrics/crm.opportunities_by_stage/drilldown?${q}`, { perms: [...READ, 'analytics:drilldown', 'crm:opportunities:read'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.rows.length, Number(kpi.value));
  const denied = await env.call('GET', `/analytics/metrics/crm.opportunities_by_stage/drilldown?${q}`, { perms: READ });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code || denied.body.error?.code, 'ANALYTICS_DRILLDOWN_FORBIDDEN');
});

test('m9d631 isolamento entre empresas no KPI', async () => { // 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece
  for (const code of ['crm.opportunities_by_stage', 'crm.conversion_rate']) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador publicado nem o snapshot da A');
  }
  const asB = await env.call('GET', `/analytics/metrics/crm.loss_reasons?asOf=${AS_OF}&companyId=${env.tenantA.companyId}`, { perms: READ, tenant: 'B' });
  assert.equal(asB.status, 404, 'B pedindo a empresa A');
});

test('m9d631 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('crm.conversion_rate', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('crm.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('crm.loss_reasons', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
