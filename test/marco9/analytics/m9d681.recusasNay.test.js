'use strict';

// M9-D681 (critério 9, reabertura) — toda recusa da NAY Diretoria vira linha BLOCKED em ai.tool_calls com os códigos de motivo do KPI, o contador
// nayaraone_api_ai_tool_calls_blocked_total sobe junto com a linha e o KPI ai.tool_calls_blocked soma essas recusas: inclusive a anterior ao pipeline
// de segurança (ferramenta fora do catálogo, motivo ALLOWLIST) e a permissão negada dentro da ferramenta do BI (motivo PERMISSION).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d681Env');
const sup = require('../../analytics.m9d603.support');
const { register } = require('../../../src/utils/metrics');
const { buildUserContext } = require('../../../src/features/ai/orchestrator/executionContext');
const { buildNayDiretoriaRegistry, nayDiretoriaAllowlist, runNayDiretoriaToolCall, NAY_DIRETORIA_AGENT_CODE } = require('../../../src/features/ai/tools');

const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });
const DIA = '2026-10-28T13:00:00Z'; // as linhas gravadas pelo pipeline têm o instante de agora: o teste as leva ao dia do cenário (relógio fixo)
let env; let nayRegistry; let runId;
before(async () => {
  env = await kit.setup();
  const seeded = await kit.seedAi(env, env.cX);
  runId = seeded.comercial[0];
  nayRegistry = await buildNayDiretoriaRegistry();
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX); // publica as métricas de IA da empresa (a ferramenta getMetric lê a definição publicada)
});
after(async () => {
  await direto('DELETE FROM ai.tool_calls WHERE company_id = :c AND idempotency_key NOT LIKE :p', { c: env.cX.companyId, p: 'm9d681-%' });
  await kit.teardown(env);
});

/** A chamada finalizada é imutável (gatilho): o teste, que é o superusuário do banco descartável, desliga os gatilhos só nesta transação. */
const direto = (sql, replacements) => env.admin.transaction(async (transaction) => {
  await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
  await env.admin.query(sql, { replacements, transaction });
});
const counter = register.getSingleMetric('nayaraone_api_ai_tool_calls_blocked_total');
const counted = async (reason) => ((await counter.get()).values.find((v) => v.labels.reason === reason) || { value: 0 }).value;
const agent = () => ({ id: 'ag-dir', code: NAY_DIRETORIA_AGENT_CODE, version: 1, tools: nayDiretoriaAllowlist() });
const ctx = (permissions) => buildUserContext({ userId: env.cX.userId, groupId: env.cX.groupId, companyId: env.cX.companyId, roles: ['DIRETORIA'], permissions }, { correlationId: 'corr-m9d681', runId });

/** Chamada como o orquestrador faz: pelo pipeline, SEM gravador de teste (a linha vai para ai.tool_calls de verdade) e com commit. */
const call = (permissions, toolName, args) => sup.inTx(env.cX, { commit: true }, (tx) => runNayDiretoriaToolCall({
  execCtx: ctx(permissions), agent: agent(), registry: nayRegistry, toolName, args, transaction: tx, argsLimits: LIMITES,
}).then(() => null, (e) => e));

async function kpi() {
  await direto("UPDATE ai.tool_calls SET started_at = :d WHERE company_id = :c AND idempotency_key NOT LIKE 'm9d681-%' AND started_at > '2026-10-29'", { d: DIA, c: env.cX.companyId });
  await kit.rebuild(env.cX);
  return (await kit.kpis(env.cX)).ia.kpis['ai.tool_calls_blocked'];
}
const rowsOf = async () => (await env.admin.query("SELECT tool_name, status, blocked_reason FROM ai.tool_calls WHERE company_id = :c AND idempotency_key NOT LIKE 'm9d681-%' ORDER BY seq", { replacements: { c: env.cX.companyId } }))[0];

test('m9d681 recusa da NAY anterior ao pipeline (ferramenta fora do catálogo) vira linha BLOCKED ALLOWLIST, sobe o contador e o KPI em 1', async () => {
  const before0 = await kpi();
  const c0 = await counted('ALLOWLIST');
  const err = await call(['analytics:read', 'finance:read'], 'analytics.runSql', { sql: 'SELECT 1' });
  assert.deepEqual([err.statusCode, err.code], [403, 'ANALYTICS_AI_TOOL_NOT_ALLOWED']);
  assert.deepEqual(await rowsOf(), [{ tool_name: 'analytics.runSql', status: 'BLOCKED', blocked_reason: 'ALLOWLIST' }]);
  assert.equal(await counted('ALLOWLIST'), c0 + 1, 'o contador usa o mesmo código de motivo da linha (ALLOWLIST, não NOT_ALLOWED)');
  assert.equal(await counted('NOT_ALLOWED'), 0, 'o rótulo antigo não existe mais');
  const after1 = await kpi();
  assert.equal(Number(after1.value), Number(before0.value) + 1, 'o KPI sobe em 1');
  assert.equal(Number(after1.details.byReason.ALLOWLIST), Number(before0.details.byReason.ALLOWLIST) + 1);
  assert.equal(Number(after1.details.calls), Number(before0.details.calls) + 1);
});

test('m9d681 permissão negada dentro da ferramenta do BI grava BLOCKED PERMISSION (não FAILED), conta uma vez e o KPI concorda com o contador', async () => {
  const before0 = await kpi();
  const c0 = await counted('PERMISSION');
  const rows0 = (await rowsOf()).length;
  const err = await call(['analytics:read'], 'analytics.getMetric', { metricCode: 'ai.cost_by_agent', period: '2026-10' });
  assert.deepEqual([err.statusCode, err.code], [403, 'ANALYTICS_DRILLDOWN_FORBIDDEN']);
  const rows = await rowsOf();
  assert.equal(rows.length, rows0 + 1);
  assert.deepEqual(rows[rows.length - 1], { tool_name: 'analytics.getMetric', status: 'BLOCKED', blocked_reason: 'PERMISSION' });
  assert.equal(await counted('PERMISSION'), c0 + 1, 'uma recusa, uma contagem');
  const after1 = await kpi();
  assert.equal(Number(after1.value) - Number(before0.value), (await counted('PERMISSION')) - c0, 'KPI e contador concordam');
  assert.equal(Number(after1.details.byReason.PERMISSION), Number(before0.details.byReason.PERMISSION) + 1);
});

test('m9d681 argumento inválido e permissão efetiva ausente também chegam ao KPI com os motivos SCHEMA e PERMISSION', async () => {
  const before0 = await kpi();
  const schema = await call(['analytics:read', 'finance:read'], 'analytics.getMetric', { metricCode: 'fin.caixa; DROP TABLE x', period: '2026-10' });
  assert.equal(schema.statusCode, 400);
  const semBi = await call([], 'analytics.getMetric', { metricCode: 'ai.cost_by_agent', period: '2026-10' });
  assert.equal(semBi.code, 'AI_PERMISSION_DENIED');
  const after1 = await kpi();
  assert.equal(Number(after1.value), Number(before0.value) + 2);
  assert.equal(Number(after1.details.byReason.SCHEMA), Number(before0.details.byReason.SCHEMA || 0) + 1);
  assert.equal(Number(after1.details.byReason.PERMISSION), Number(before0.details.byReason.PERMISSION) + 1);
});
