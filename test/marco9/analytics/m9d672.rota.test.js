'use strict';

// M9-D672 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas; recusas;
// replay do mesmo evento (helper compartilhado assertReplayIdempotent da M9-D607).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const kit = require('../_helpers/m9d672Env');
const sc = require('../_helpers/m9d672Scenario');
const oracle = require('../_helpers/m9d672Oracle');
const asserts = require('../_helpers/readModelAsserts');
const clock = require('../../../src/features/analytics/metrics/clock');
const { materializeSupportKpis } = require('../../../src/features/analytics/metrics/kpis');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const { AS_OF, CODES, MODELS } = { ...kit };
const READ = ['analytics:read', 'crm:feedback:read']; // M9-D702: a rota de métrica confere também a permissão do domínio (M9-D700)
let env;
let src;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  await sc.avaliacoes(src, t);
  await sc.reclamacoes(src, t);
  await sc.slas(src, t);
  await bi.setSetting(env, t, 'analytics.marketing_atendimento.janela_reconferencia_dias', 90);
  await bi.runSchedule(t, bi.NOW);
  await http.inTx(t, { commit: true }, (tx) => materializeSupportKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId };
  // o refresh da agenda liga os KPIs de todos os domínios: apaga o que eles publicaram para a empresa (definições, versões e snapshots)
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...src.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c)', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c', { replacements: ids, transaction });
    for (const m of MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: ids, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.marketing_atendimento.janela_reconferencia_dias'", { replacements: ids, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id = :c`, { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d672 GET /analytics/metrics/sup.reviews devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('sup.reviews')).body.data;
  assert.equal(money.cmp(d.value, (await oracle.reviewsFromSource(src, env.tenantA, '2026-10')).average), 0);
  shape(d, 'sup.reviews', 'SCORE', 'marketing.review_requests');
});

test('m9d672 GET /analytics/metrics/sup.satisfaction devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('sup.satisfaction')).body.data;
  assert.equal(money.cmp(d.value, (await oracle.satisfactionFromSource(src, env.tenantA, '2026-10')).average), 0);
  shape(d, 'sup.satisfaction', 'SCORE', 'marketing.review_requests');
});

test('m9d672 GET /analytics/metrics/sup.complaints_by_reason devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('sup.complaints_by_reason')).body.data;
  const want = await oracle.complaintsFromSource(src, env.tenantA, '2026-10');
  assert.equal(Number(d.value), Object.values(want).reduce((a, n) => a + n, 0));
  shape(d, 'sup.complaints_by_reason', 'COUNT', 'crm.feedback_cases');
});

test('m9d672 GET /analytics/metrics/sup.sla_resolution devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('sup.sla_resolution')).body.data;
  assert.equal(money.cmp(d.value, (await oracle.slaFromSource(src, env.tenantA, '2026-10', bi.NOW)).pct), 0);
  shape(d, 'sup.sla_resolution', 'PERCENT', 'crm.feedback_cases');
});

test('m9d672 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d672 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('sup.reviews', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('sup.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('sup.reviews', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d672 replay do mesmo evento não altera o valor (assertReplayIdempotent sobre os read models dos KPIs)', async () => {
  const t = env.tenantA;
  const month = { sup_reviews: ['review.requested', 'rm_mkt_reviews'], sup_satisfaction: ['review.requested', 'rm_support_satisfaction'], sup_sla: ['crm.feedback_case.resolved', 'rm_support_sla'], sup_complaints: ['crm.feedback_case.created', 'rm_support_complaints'] };
  for (const [type, model] of Object.values(month)) {
    const payload = model === 'rm_support_complaints' ? { type: 'COMPLAINT' } : { slaDueAt: '2026-10-05T10:00:00Z', resolvedAt: '2026-10-05T10:00:00Z' };
    const event = bi.makeEvent(t, type, { id: bi.uuid(), ...payload });
    const read = async () => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3, 4`, { replacements: { c: t.companyId } }))[0];
    await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(t, event), readRow: read });
  }
  const before = (await get('sup.reviews')).body.data.value;
  await http.inTx(t, { commit: true }, (tx) => materializeSupportKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  assert.equal((await get('sup.reviews')).body.data.value, before);
});
