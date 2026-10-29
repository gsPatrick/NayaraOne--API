'use strict';

// M9-D029 — os sete eventos ai.* no outbox transacional, com o payload e a chave de idempotência da tabela da demanda.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, ctxDe } = require('../../helpers/aiRuns');
const runs = require('../../../src/features/ai/orchestrator/runs');
const rec = require('../../../src/features/ai/recommendations');
const budgets = require('../../../src/features/ai/budgets');
const { publishInjectionEvents } = require('../../../src/features/ai/orchestrator/injectionEvents');
const { dadosComAcao, comPerm } = require('../_helpers/iaRecomendacao');
const { abrirRun: abrirRunTool, rodar, linhas, ferramenta } = require('../_helpers/iaToolCalls');
const { agente, criarOrcamento, gastar } = require('../_helpers/iaOrcamento');
const { eventos, chaves, abrirRun } = require('../_helpers/iaEventos');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const um = async (tipo, id, tx) => { const e = await eventos(tipo, id, tx); assert.equal(e.length, 1, `${tipo}: ${e.length} evento(s)`); return e[0]; };

test('m9d029_emite_ai_run_completed', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const run = await abrirRun(ctx, tx);
    await runs.finishRun(ctx, run.id, {
      status: 'COMPLETED', outputSummary: 'ok', providerCode: 'sandbox', modelCode: 'sandbox-small', routingPath: 'SMALL_MODEL', latencyMs: 12,
      groundingStatus: 'GROUNDED', costAmount: '0.021000', tokensIn: 10, tokensOut: 5,
    }, tx);
    const e = await um('ai.run.completed', run.id, tx);
    assert.equal(e.aggregate_type, 'AiRun');
    assert.equal(e.idempotency_key, `ai.run.completed:${run.id}`);
    assert.equal(e.event_version, 1);
    assert.equal(e.classification, 'INTERNAL');
    assert.deepEqual(chaves(e), ['agentCode', 'agentVersion', 'costAmount', 'groundingStatus', 'latencyMs', 'model', 'provider', 'routingPath', 'runId']);
    assert.deepEqual(e.payload_json, {
      runId: run.id, agentCode: 'NAY_FINANCEIRA', agentVersion: run.agentVersion, provider: 'sandbox', model: 'sandbox-small', routingPath: 'SMALL_MODEL',
      costAmount: '0.021000', groundingStatus: 'GROUNDED', latencyMs: 12,
    });
  });
});

test('m9d029_emite_ai_run_failed', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const falho = await abrirRun(ctx, tx);
    await runs.finishRun(ctx, falho.id, { status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT' }, tx);
    const f = await um('ai.run.failed', falho.id, tx);
    assert.equal(f.idempotency_key, `ai.run.failed:${falho.id}`);
    assert.deepEqual(f.payload_json, { runId: falho.id, agentCode: 'NAY_FINANCEIRA', errorCode: 'PROVIDER_TIMEOUT', blockedReason: null });
    // BLOCKED também é ai.run.failed (a tabela da demanda: "run vai a FAILED ou BLOCKED").
    const barrado = await abrirRun(ctx, tx);
    await runs.finishRun(ctx, barrado.id, { status: 'BLOCKED', blockedReason: 'TOOL_LIMIT' }, tx);
    const b = await um('ai.run.failed', barrado.id, tx);
    assert.deepEqual(b.payload_json, { runId: barrado.id, agentCode: 'NAY_FINANCEIRA', errorCode: null, blockedReason: 'TOOL_LIMIT' });
    assert.equal((await eventos('ai.run.completed', barrado.id, tx)).length, 0);
  });
});

test('m9d029_run_aguardando_aprovacao_e_cancelado_sem_evento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const tipos = ['ai.run.completed', 'ai.run.failed'];
    const total = async (id) => (await Promise.all(tipos.map((t) => eventos(t, id, tx)))).flat().length;
    const aprovado = await abrirRun(ctx, tx);
    await runs.finishRun(ctx, aprovado.id, { status: 'AWAITING_APPROVAL', outputSummary: 'proposta' }, tx);
    assert.equal(await total(aprovado.id), 0, 'entrar em AWAITING_APPROVAL não emite');
    await runs.finishRun(ctx, aprovado.id, { status: 'COMPLETED', providerCode: 'sandbox', modelCode: 'm', routingPath: 'RULE', groundingStatus: 'GROUNDED' }, tx);
    const emitido = await um('ai.run.completed', aprovado.id, tx);
    assert.equal(emitido.payload_json.runId, aprovado.id, 'AWAITING_APPROVAL -> COMPLETED emite');
    assert.equal(emitido.classification, 'INTERNAL');
    assert.deepEqual(Object.keys(emitido.payload_json).sort(), ['agentCode', 'agentVersion', 'costAmount', 'groundingStatus', 'latencyMs', 'model', 'provider', 'routingPath', 'runId']);
    const cancelado = await abrirRun(ctx, tx);
    await runs.finishRun(ctx, cancelado.id, { status: 'AWAITING_APPROVAL' }, tx);
    await runs.finishRun(ctx, cancelado.id, { status: 'CANCELLED' }, tx);
    assert.equal(await total(cancelado.id), 0, 'AWAITING_APPROVAL -> CANCELLED não emite');
  });
});

test('m9d029_emite_ai_recommendation_created', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const { recommendation: r } = await rec.createRecommendation(nay, dadosComAcao(), tx);
    const e = await um('ai.recommendation.created', r.id, tx);
    assert.equal(e.aggregate_type, 'AiRecommendation');
    assert.equal(e.idempotency_key, `ai.recommendation.created:${r.id}`);
    assert.deepEqual(e.payload_json, { recommendationId: r.id, agentCode: r.agentCode, type: r.recommendationType, riskLevel: r.riskLevel, targetUserId: r.targetUserId });
  });
});

test('m9d029_emite_ai_recommendation_accepted', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const { recommendation: r } = await rec.createRecommendation(nay, dadosComAcao(), tx);
    const { recommendation: aceita } = await rec.acceptRecommendation(ana, r.id, { reason: 'faz sentido' }, tx);
    const e = await um('ai.recommendation.accepted', r.id, tx);
    assert.equal(e.idempotency_key, `ai.recommendation.accepted:${r.id}`);
    assert.deepEqual(e.payload_json, { recommendationId: r.id, decidedBy: ana.userId, outcome: aceita.outcome });
    await rec.acceptRecommendation(ana, r.id, {}, tx); // replay do mesmo decisor: nenhum evento novo
    assert.equal((await eventos('ai.recommendation.accepted', r.id, tx)).length, 1);
  });
});

test('m9d029_emite_ai_recommendation_rejected', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const { recommendation: r } = await rec.createRecommendation(nay, dadosComAcao(), tx);
    await rec.rejectRecommendation(ana, r.id, { reason: 'ligue para maria.silva@empresa.com.br antes' }, tx);
    const e = await um('ai.recommendation.rejected', r.id, tx);
    assert.equal(e.idempotency_key, `ai.recommendation.rejected:${r.id}`);
    assert.deepEqual(chaves(e), ['decidedBy', 'reasonCode', 'recommendationId']);
    assert.equal(e.payload_json.decidedBy, ana.userId);
    assert.equal(e.payload_json.reasonCode, 'REASON_PROVIDED', 'só o código; o texto livre do motivo nunca sai no evento');
    assert.ok(!JSON.stringify(e.payload_json).includes('maria.silva'));
  });
});

test('m9d029_emite_ai_tool_call_blocked', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const runId = await abrirRunTool(ctx, tx);
    const { tool } = ferramenta();
    await rodar({ tenant: tenantA, ctx, tx, runId, tool, nome: 'crm.nao_existe', input: { ref: 'X' }, seq: 1, over: { registry: {} } }).catch(() => null);
    const [linha] = await linhas(runId, tx);
    const e = await um('ai.tool_call.blocked', linha.id, tx);
    assert.equal(e.aggregate_type, 'AiToolCall');
    assert.equal(e.idempotency_key, `ai.tool_call.blocked:${linha.id}`);
    assert.deepEqual(e.payload_json, { toolCallId: linha.id, runId, toolName: 'crm.nao_existe', reason: 'tool_nao_registrada' });
  });
});

test('m9d029_emite_ai_budget_threshold_reached_uma_vez', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:100]]' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:1]]' });
    const e = await um('ai.budget.threshold_reached', b.id, tx);
    const inicio = new Date(b.periodStart).toISOString();
    assert.equal(e.aggregate_type, 'AiBudget');
    assert.equal(e.event_version, 1);
    assert.equal(e.classification, 'INTERNAL');
    assert.equal(e.idempotency_key, `ai.budget.threshold_reached:${b.id}:50:${inicio}`);
    assert.deepEqual(e.payload_json, { budgetId: b.id, threshold: 50, consumedPct: '50.00', periodStart: inicio });
    assert.ok(budgets.estimateCost, 'o módulo de orçamento continua exportando o portão');
  });
});

test('m9d029_emite_ai_security_prompt_injection_detected', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const runId = crypto.randomUUID();
    const det = { sourceId: 'src-1', origin: 'DOCUMENT', patternIds: ['IGNORAR_INSTRUCOES'], score: 0.95, action: 'QUARANTINED', contentHash: 'a'.repeat(64), excerpt: 'trecho [REDIGIDO:email]' };
    await publishInjectionEvents(tenantA, runId, [det], tx);
    await publishInjectionEvents(tenantA, runId, [det], tx);
    const e = await um('ai.security.prompt_injection_detected', runId, tx);
    assert.equal(e.aggregate_type, 'AiRun');
    assert.equal(e.event_version, 1);
    assert.equal(e.classification, 'INTERNAL');
    for (const campo of ['runId', 'sourceId', 'origin', 'patternIds', 'score', 'action']) assert.ok(campo in e.payload_json, campo);
    assert.equal(e.payload_json.runId, runId);
    assert.equal(e.payload_json.action, 'QUARANTINED');
    assert.match(e.idempotency_key, new RegExp(`^ai\\.security\\.prompt_injection_detected:${runId}:src-1`));
  });
});
