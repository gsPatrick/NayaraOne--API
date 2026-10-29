'use strict';

const { AiRun, AiSource, AiRecommendation } = require('../../../../models');
const { toRun, toSource } = require('../runs/runs.mapper');
const { failureOutcome } = require('./flow.outcome');
const E = require('./flow.errors');

/** HTTP dos erros que terminam um run (para devolver a mesma resposta ao repetir a chamada). Código fora da tabela: 422. */
const STATUS_BY_CODE = Object.freeze({
  AI_AGENT_DISABLED: 409, AI_AGENT_NOT_FOUND: 404, AI_BUDGET_EXHAUSTED: 429, AI_BUDGET_NOT_CONFIGURED: 403, AI_NO_ELIGIBLE_MODEL: 503, AI_INJECTION_BLOCKED: 422,
  AI_PROVIDER_UNAVAILABLE: 503, AI_FALLBACK_UNSAFE: 503, AI_RUN_TIMEOUT: 504, AI_TOOL_NOT_ALLOWED: 403, AI_PERMISSION_DENIED: 403, AI_TOOL_ARGS_INVALID: 400,
  AI_TOOL_ARGS_FORBIDDEN_FIELD: 400, AI_CROSS_COMPANY_BLOCKED: 404, AI_SECRET_REQUEST_BLOCKED: 403, AI_TOOL_LIMIT_EXCEEDED: 422, AI_MAX_TURNS_EXCEEDED: 422,
  AI_TOKEN_LIMIT_EXCEEDED: 422, AI_OUTPUT_INVALID: 422, AI_UNGROUNDED_FACT: 422, AI_NUMBER_NOT_FROM_SOURCE: 422,
});

/**
 * Repetir a chamada com a mesma `idempotencyKey` e o mesmo pedido devolve o run existente (D005), sem gerar custo nem executar tool de
 * novo (`replayed: true`): COMPLETED e AWAITING_APPROVAL devolvem a resposta e as propostas gravadas; FAILED e BLOCKED, o mesmo erro;
 * RUNNING (ainda em andamento) é 409 AI_TOOL_CALL_IN_PROGRESS.
 */
async function replayOutcome(ctx, run, transaction, trace) {
  const row = await AiRun.findOne({ where: { id: run.id, companyId: ctx.companyId }, transaction });
  const current = toRun(row);
  if (current.status === 'RUNNING') return failureOutcome(current.id, E.inProgress(), null, { replayed: true, trace });
  if (current.status === 'FAILED' || current.status === 'BLOCKED') {
    const code = current.errorCode || 'AI_RUN_ERROR';
    const error = Object.assign(new Error(current.message || 'A consulta não pôde ser concluída.'), { statusCode: STATUS_BY_CODE[code] || 422, code });
    return failureOutcome(current.id, error, { status: current.status, blockedReason: current.blockedReason }, { replayed: true, trace });
  }
  const sources = await AiSource.findAll({ where: { aiRunId: current.id, companyId: ctx.companyId }, order: [['retrievedAt', 'ASC'], ['id', 'ASC']], transaction });
  const recs = await AiRecommendation.findAll({ where: { aiRunId: current.id, companyId: ctx.companyId }, order: [['id', 'ASC']], transaction });
  return {
    ok: true, replayed: true, runId: current.id, status: current.status, answer: current.outputSummary, sources: sources.map(toSource), groundingStatus: current.groundingStatus,
    confidence: current.confidence, snapshotAt: current.snapshotAt, proposals: recs.map((r) => ({ id: r.id, status: r.status })),
    cost: { amount: current.costAmount, tokensIn: current.tokensIn, tokensOut: current.tokensOut }, routingPath: current.routingPath, escalated: current.escalated, cached: current.cached, trace,
  };
}

module.exports = { replayOutcome, STATUS_BY_CODE };
