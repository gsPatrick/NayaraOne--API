'use strict';

// M9-D681 — GET /v1/analytics/metrics/<código> dos quatro KPIs de IA pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas; recusas; replay do
// mesmo evento (helper compartilhado assertReplayIdempotent da M9-D607); o contador nayaraone_api_ai_tool_calls_blocked_total da NAY Diretoria (M9-D695).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const kit = require('../_helpers/m9d681Env');
const oracle = require('../_helpers/m9d681Oracle');
const asserts = require('../_helpers/readModelAsserts');
const clock = require('../../../src/features/analytics/metrics/clock');
const { materializeIaKpis } = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, CODES, MODELS } = { ...kit };
const PERMS = ['analytics:read', 'analytics:read:tech'];
let env;
let src;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  await kit.seedAi(src, env.tenantA);
  await bi.runSchedule(env.tenantA, bi.NOW);
  await http.inTx(env.tenantA, { commit: true }, (tx) => materializeIaKpis({ companyId: env.tenantA.companyId, groupId: env.tenantA.groupId }, AS_OF, tx));
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

test('m9d681 GET /analytics/metrics/ai.cost_by_agent devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('ai.cost_by_agent')).body.data;
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), Number((await oracle.cost(src, env.tenantA, '2026-10')).total));
  shape(d, 'ai.cost_by_agent', 'BRL', 'ai.ai_runs');
  assert.equal(d.sourceRefs[0].count, 10, 'as dez execuções concluídas de outubro são a origem do número');
});

test('m9d681 GET /analytics/metrics/ai.quality_scores devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('ai.quality_scores')).body.data;
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), Number((await oracle.grounding(src, env.tenantA, '2026-10-26')).value));
  shape(d, 'ai.quality_scores', 'PERCENT', 'ai.ai_runs');
});

test('m9d681 GET /analytics/metrics/ai.budget devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('ai.budget')).body.data;
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), 71.25);
  shape(d, 'ai.budget', 'PERCENT', 'ai.budgets');
});

test('m9d681 GET /analytics/metrics/ai.tool_calls_blocked devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('ai.tool_calls_blocked')).body.data;
  assert.equal(d.status, 'OK');
  assert.equal(Number(d.value), (await oracle.toolCalls(src, env.tenantA, '2026-10', AS_OF)).blocked);
  shape(d, 'ai.tool_calls_blocked', 'COUNT', 'ai.tool_calls');
  assert.equal(d.sourceRefs[0].count, 3, 'as três chamadas BLOCKED do mês reproduzem o número');
});

test('m9d681 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d681 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noRead = await get('ai.budget', { perms: [] });
  assert.equal(noRead.status, 403);
  assert.equal(noRead.body.code || noRead.body.error?.code, 'PERMISSION_DENIED');
  const noTech = await get('ai.budget', { perms: ['analytics:read'] });
  assert.equal(noTech.status, 403, 'a permissão do domínio Tecnologia também é exigida');
  const missing = await get('ai.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('ai.budget', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d681 replay do mesmo evento não altera o valor (assertReplayIdempotent sobre os read models dos KPIs)', async () => {
  const t = env.tenantA;
  for (const [type, model] of [['ai.run.completed', 'rm_ai_cost'], ['ai.tool_call.blocked', 'rm_ai_tool_calls'], ['ai.evaluation.finished', 'rm_ai_quality']]) {
    const event = bi.makeEvent(t, type, { id: bi.uuid() });
    const read = async () => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3, 4`, { replacements: { c: t.companyId } }))[0];
    await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(t, event), readRow: read });
  }
  const before = (await get('ai.cost_by_agent')).body.data.value;
  await http.inTx(t, { commit: true }, (tx) => materializeIaKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  assert.equal((await get('ai.cost_by_agent')).body.data.value, before);
});

test('m9d681 o contador nayaraone_api_ai_tool_calls_blocked_total da NAY Diretoria conta os mesmos motivos que o KPI separa', async () => {
  const { register } = require('../../../src/utils/metrics');
  const { assertNayToolAllowed, countBlocked } = require('../../../src/features/analytics/briefs');
  const counter = register.getSingleMetric('nayaraone_api_ai_tool_calls_blocked_total');
  assert.ok(counter, 'o contador existe');
  const read = async (reason) => ((await counter.get()).values.find((v) => v.labels.reason === reason) || { value: 0 }).value;
  const b0 = await read('NOT_ALLOWED');
  assert.throws(() => assertNayToolAllowed('tool.fora_do_catalogo'), (e) => e.code === 'ANALYTICS_AI_TOOL_NOT_ALLOWED');
  countBlocked('PERMISSION');
  assert.equal(await read('NOT_ALLOWED'), b0 + 1);
  const { IA_KPI_DEFAULTS, KEYS } = require('../../../src/features/analytics/read-models/iaKpi.settings');
  const known = IA_KPI_DEFAULTS[KEYS.knownBlockReasons].split(',');
  for (const reason of ['ALLOWLIST', 'PERMISSION', 'SCHEMA', 'INJECTION', 'CROSS_COMPANY', 'SECRET', 'BUDGET', 'POLICY', 'STALE']) assert.ok(known.includes(reason), `o KPI separa o motivo ${reason}`);
});
