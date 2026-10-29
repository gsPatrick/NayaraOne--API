'use strict';

const { publishAiEvent } = require('./aiEvents.publish');

/** Estado final do run -> evento do livro. AWAITING_APPROVAL e CANCELLED não emitem (o livro não os lista). */
const RUN_EVENT_BY_STATUS = Object.freeze({ COMPLETED: 'ai.run.completed', FAILED: 'ai.run.failed', BLOCKED: 'ai.run.failed' });

/** Run que chegou a COMPLETED (inclusive AWAITING_APPROVAL -> COMPLETED), FAILED ou BLOCKED; outro estado devolve null. `run` é o objeto do mapper. */
async function publishRunEvent(ctx, run, transaction) {
  const type = RUN_EVENT_BY_STATUS[run.status];
  if (!type) return null;
  return publishAiEvent(ctx, type, {
    runId: run.id, agentCode: run.agentCode, agentVersion: run.agentVersion, provider: run.providerCode, model: run.modelCode,
    routingPath: run.routingPath, costAmount: run.costAmount, groundingStatus: run.groundingStatus, latencyMs: run.latencyMs,
    errorCode: run.errorCode, blockedReason: run.blockedReason,
  }, transaction);
}

/** created / accepted / rejected. O texto livre do motivo nunca sai: só o código REASON_PROVIDED ou NOT_INFORMED (DI-D029-1). */
function publishRecommendationEvent(ctx, type, rec, transaction) {
  return publishAiEvent(ctx, type, {
    recommendationId: rec.id, agentCode: rec.agentCode, type: rec.recommendationType, riskLevel: rec.riskLevel, targetUserId: rec.targetUserId,
    decidedBy: rec.decidedByUserId, outcome: rec.outcome || null, reasonCode: rec.decisionReason ? 'REASON_PROVIDED' : 'NOT_INFORMED',
  }, transaction);
}

/** Tool bloqueada: só ids, nome da tool e o código do motivo (nunca argumento nem resultado). */
function publishToolCallBlocked(ctx, call, transaction, options) {
  return publishAiEvent(ctx, 'ai.tool_call.blocked', {
    toolCallId: call.toolCallId, runId: call.runId, toolName: call.toolName, reason: call.reason,
  }, transaction, options);
}

function publishBudgetThreshold(budget, threshold, consumedPct, transaction) {
  return publishAiEvent(budget, 'ai.budget.threshold_reached', {
    budgetId: budget.id, threshold, consumedPct, periodStart: budget.periodStart,
  }, transaction);
}

function publishInjectionDetected(ctx, runId, detection, transaction) {
  return publishAiEvent(ctx, 'ai.security.prompt_injection_detected', { ...detection, runId }, transaction);
}

module.exports = { publishRunEvent, publishRecommendationEvent, publishToolCallBlocked, publishBudgetThreshold, publishInjectionDetected, RUN_EVENT_BY_STATUS };
