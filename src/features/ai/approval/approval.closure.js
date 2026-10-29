'use strict';

/**
 * Fechamento do tool_call e do run pela decisão da recomendação (M9-D019, na MESMA transação da decisão). Executor das transições:
 * o ApprovalService, nunca a NAY. EXECUTED -> tool_call SUCCEEDED e run COMPLETED; EXECUTION_FAILED -> FAILED e COMPLETED;
 * REJECTED -> CANCELLED_BY_HUMAN e CANCELLED; STALE -> BLOCKED (STALE) e CANCELLED. Não existe expiração por tempo.
 */
const { AiRun } = require('../../../models');
const { settleProposedToolCall } = require('../tools');
const runs = require('../orchestrator/runs');

const RUN_TARGET = Object.freeze({ EXECUTED: 'COMPLETED', EXECUTION_FAILED: 'COMPLETED', REJECTED: 'CANCELLED', STALE: 'CANCELLED' });

async function closeProposal(ctx, recommendation, decisionStatus, transaction, { errorCode, detail } = {}) {
  try {
    await settleProposedToolCall(ctx, { proposalId: recommendation.id, recommendationStatus: decisionStatus, errorCode }, transaction);
  } catch (err) {
    if (err.code !== 'AI_TOOL_CALL_NOT_FOUND') throw err; // proposta sem chamada de tool (criada fora do orquestrador)
  }
  if (!recommendation.aiRunId) return;
  const run = await AiRun.findOne({ where: { id: recommendation.aiRunId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!run || run.status !== 'AWAITING_APPROVAL') return;
  const outputSummary = decisionStatus === 'EXECUTION_FAILED' && detail ? `A ação aprovada falhou: ${detail}` : undefined;
  await runs.finishRun(ctx, run.id, { status: RUN_TARGET[decisionStatus], ...(outputSummary ? { outputSummary } : {}) }, transaction);
}

module.exports = { closeProposal, RUN_TARGET };
