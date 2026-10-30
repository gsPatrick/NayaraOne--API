'use strict';

// M9-D047 — observabilidade da NAY: as dez métricas ai_* nascem dos eventos reais (run, ferramenta, bloqueio, insuficiência, injeção, fallback, orçamento, circuito),
// aparecem no registro Prometheus que /api/metrics expõe, e o administrador pode desligar a contagem da sua empresa. Banco descartável (RLS real), rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, ctxDe } = require('../../helpers/aiRuns');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { register } = require('../../../src/utils/metrics');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { publishInjectionEvents } = require('../../../src/features/ai/orchestrator/injectionEvents');
const { raiseAlerts } = require('../../../src/features/ai/budgets/budgets.alerts');
const obs = require('../../../src/features/ai/observability');
const { criarOrcamento, agente } = require('../_helpers/iaOrcamento');
const H = require('../_helpers/iaOrquestrador');
const F = require('../_helpers/iaFallback');
const { lerMetrica, variacao } = require('../_helpers/iaMetricas');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const consulta = (c) => H.rodar(c, `Veja ${H.pedirOportunidade(c)} [[RESPOSTA:Oportunidade consultada.]]`);

test('m9d047_metricas_ai_expostas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const ok = await consulta(c);
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    const run = await H.lerRun(ok.runId, tx);
    // Run concluído: contador por agente, estado e caminho; latência no histograma; ferramenta SUCCEEDED.
    assert.equal(await lerMetrica('ai_runs_total', { agent: c.code, status: 'COMPLETED', path: run.routing_path }), 1);
    assert.equal(await lerMetrica('ai_run_latency_ms', { agent: c.code }, '_count'), 1);
    assert.equal(await lerMetrica('ai_tool_calls_total', { tool: 'crm.getOpportunity', status: 'SUCCEEDED' }) >= 1, true);
    // Run bloqueado (tool fora da allowlist): estado BLOCKED, motivo no ai_blocked_total, chamada BLOCKED.
    const bloqueado = await H.rodar(c, 'Veja [[TOOL:finance.getWeeklyHealth:{}]] [[RESPOSTA:x]]');
    H.falhou(bloqueado, 403, 'AI_TOOL_NOT_ALLOWED', 'BLOCKED');
    const motivo = (await H.lerRun(bloqueado.runId, tx)).blocked_reason;
    assert.ok(motivo, 'o run bloqueado guarda o motivo');
    assert.equal(await lerMetrica('ai_runs_total', { agent: c.code, status: 'BLOCKED' }), 1);
    assert.equal(await lerMetrica('ai_blocked_total', { reason: motivo }) >= 1, true);
    assert.equal(await lerMetrica('ai_tool_calls_total', { tool: 'finance.getWeeklyHealth', status: 'BLOCKED' }) >= 1, true);
  });
});

test('m9d047_metricas_run_custo_insuficiencia_e_regra', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use'] };
    const agent = `M47_${crypto.randomUUID().slice(0, 8)}`;
    const abrir = async () => (await runs.startRun(ctx, { agentName: agent, purpose: 'teste' }, tx)).run;
    const { id } = await abrir();
    await runs.finishRun(ctx, id, { status: 'COMPLETED', groundingStatus: 'INSUFFICIENT_SOURCES', providerCode: 'prov-m47', costAmount: '1.250000', latencyMs: 480, routingPath: 'SMALL_MODEL' }, tx);
    assert.equal(await lerMetrica('ai_cost_brl_total', { agent, provider: 'prov-m47' }), 1.25, 'custo em reais');
    assert.equal(await lerMetrica('ai_run_latency_ms', { agent }, '_count'), 1);
    assert.equal(await lerMetrica('ai_run_latency_ms', { agent, le: '500' }, '_bucket'), 1, '480 ms cai no limite de 500');
    assert.equal(await lerMetrica('ai_run_latency_ms', { agent, le: '250' }, '_bucket'), 0);
    const antes = await lerMetrica('ai_insufficient_sources_total');
    const segundo = await abrir();
    await runs.finishRun(ctx, segundo.id, { status: 'COMPLETED', groundingStatus: 'INSUFFICIENT_SOURCES' }, tx);
    assert.equal(await lerMetrica('ai_insufficient_sources_total'), antes + 1);
    // Run de regra (zero custo): conta no caminho RULE e não soma custo.
    assert.equal(await variacao('ai_runs_total', { agent, status: 'COMPLETED', path: 'RULE' }, () => runs.recordRuleRun(ctx, { agentName: agent, inputSummary: 'e', outputSummary: 's' }, tx)), 1);
    assert.equal(await lerMetrica('ai_cost_brl_total', { agent, provider: 'UNKNOWN' }), 0);
    // Bloqueio sem rastro de run aberto: o motivo é o rótulo.
    const terceiro = await abrir();
    await runs.finishRun(ctx, terceiro.id, { status: 'BLOCKED', blockedReason: 'M47_SEGREDO' }, tx);
    assert.equal(await lerMetrica('ai_blocked_total', { reason: 'M47_SEGREDO' }), 1);
    // Percentis p50/p95/p99 do histograma (a estimativa vem dos limites).
    const p = await obs.latencyPercentiles({ agent });
    assert.equal(p.count, 4, 'os quatro runs terminados do agente (a duração vem de latency_ms ou de início e fim)');
    assert.ok(p.p50 <= 50, `a mediana é dos runs rápidos: ${p.p50}`);
    assert.ok(p.p50 <= p.p95 && p.p95 <= p.p99, JSON.stringify(p));
    assert.ok(p.p99 > 250 && p.p99 <= 500, `p99 dentro do limite de 250 a 500 ms: ${p.p99}`);
  });
});

test('m9d047_metricas_fallback_injecao_orcamento_e_circuito', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Fallback: o principal cai e o equivalente conclui; o salto vira ai_fallback_total{from,to}.
    const A = F.linha('m47-a', { pricePerMTokIn: 1, pricePerMTokOut: 1 });
    const B = F.linha('m47-b', { pricePerMTokIn: 2, pricePerMTokOut: 2 });
    await upsertSetting('ia.fallback.exigir_avaliacao_verde', false, ctxDe(tenantA), ctxDe(tenantA).userId, tx);
    const c = await H.cenario(tenantA, tx, { deps: F.depsDoRegistro(F.registroFalso([A, B], { falham: { 'm47-a': 'UNAVAILABLE' } })) });
    const res = await H.rodar(c, 'Classifique [[RESPOSTA:Tipo comercial.]]', { taskType: 'classificar' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(await lerMetrica('ai_fallback_total', { from: 'm47-a', to: 'm47-b' }), 1);
    // Injeção: uma detecção por origem, ALLOW não conta.
    const antes = await lerMetrica('ai_injection_detected_total', { origin: 'DOCUMENT' });
    const det = (origin, action, sourceId) => ({ sourceId, origin, patternIds: ['IGNORAR_INSTRUCOES'], score: 0.95, action, contentHash: 'a'.repeat(64), excerpt: 'ignore' });
    const runInj = crypto.randomUUID();
    await publishInjectionEvents(tenantA, runInj, [det('DOCUMENT', 'QUARANTINED', 's1'), det('DOCUMENT', 'ALLOW', 's2'), det('USER', 'QUARANTINED', 's3')], tx);
    assert.equal(await lerMetrica('ai_injection_detected_total', { origin: 'DOCUMENT' }), antes + 1);
    await publishInjectionEvents(tenantA, runInj, [det('DOCUMENT', 'QUARANTINED', 's1')], tx); // republicar a mesma detecção não conta de novo
    assert.equal(await lerMetrica('ai_injection_detected_total', { origin: 'DOCUMENT' }), antes + 1, 'idempotente como o evento');
    // Orçamento: o percentual consumido é o gauge do orçamento.
    const dono = ctxDe(tenantA);
    const b = await criarOrcamento({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId: dono.userId }, tx, { agentCode: agente(), limit: '200.00' });
    await raiseAlerts(dono, { ...b, consumedAmount: '150.000000' }, [50, 75], tx);
    assert.equal(await lerMetrica('ai_budget_pct', { budget: b.id }), 75);
    // Circuito: aberto = 1, fechado = 0.
    obs.metrics.circuitOpen('m47-a', true);
    assert.equal(await lerMetrica('ai_provider_circuit_open', { provider: 'm47-a' }), 1);
    obs.metrics.circuitOpen('m47-a', false);
    assert.equal(await lerMetrica('ai_provider_circuit_open', { provider: 'm47-a' }), 0);
    // O registro Prometheus que /api/metrics expõe traz as dez métricas.
    const texto = await register.metrics();
    for (const nome of obs.METRIC_NAMES) assert.match(texto, new RegExp(`^# TYPE ${nome} `, 'm'), nome);
    assert.equal(obs.METRIC_NAMES.length, 10);
  });
});

test('m9d047_metricas_desligadas_pelo_administrador_e_rotulos_seguros', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use'] };
    const agent = `M47_OFF_${crypto.randomUUID().slice(0, 6)}`;
    const rodar = async () => { const { run } = await runs.startRun(ctx, { agentName: agent, purpose: 'teste' }, tx); await runs.finishRun(ctx, run.id, { status: 'COMPLETED' }, tx); };
    assert.equal(await variacao('ai_runs_total', { agent }, rodar), 1, 'ligada por padrão');
    await upsertSetting('ia.observabilidade.metricas_ativas', false, ctx, ctx.userId, tx);
    assert.equal(await variacao('ai_runs_total', { agent }, rodar), 0, 'desligada: nada é contado');
    await upsertSetting('ia.observabilidade.metricas_ativas', true, ctx, ctx.userId, tx);
    assert.equal(await variacao('ai_runs_total', { agent }, rodar), 1);
  });
  // Observar nunca derruba a operação: entrada absurda não lança, e o rótulo é cortado.
  assert.doesNotThrow(() => obs.metrics.runFinished(null));
  obs.metrics.toolCall('x'.repeat(500), 'SUCCEEDED');
  assert.equal(await lerMetrica('ai_tool_calls_total', { tool: 'x'.repeat(80), status: 'SUCCEEDED' }), 1);
  // Limites do histograma: variável inválida volta ao padrão.
  assert.deepEqual(obs.latencyBuckets('10,20,30'), [10, 20, 30]);
  assert.deepEqual(obs.latencyBuckets('30,20'), obs.latencyBuckets(undefined));
  assert.deepEqual(obs.latencyBuckets('abc'), obs.latencyBuckets(undefined));
});
