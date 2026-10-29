'use strict';

const E = require('./toolCalls.errors');
const { IN_PROGRESS } = require('./toolCalls.constants');

/**
 * Chamada que já existe com a mesma chave (replay): devolve o resultado ANTERIOR com replayed=true e nunca executa de novo.
 * SUCCEEDED/FAILED/CANCELLED_BY_HUMAN devolvem o estado e o resumo; PROPOSED devolve a mesma proposta; BLOCKED recusa de novo com
 * 409 AI_TOOL_CALL_BLOCKED com o motivo original; em andamento (REQUESTED, VALIDATED, EXECUTING) é 409 AI_TOOL_CALL_IN_PROGRESS.
 */
function replayOutcome(call) {
  if (IN_PROGRESS.includes(call.status)) throw E.inProgress();
  if (call.status === 'BLOCKED') throw E.alreadyBlocked(call.blockedReason);
  if (call.status === 'PROPOSED') return { status: 'PROPOSED', proposal: { id: call.proposalId }, replayed: true, toolCallId: call.id };
  return { status: call.status, output: call.resultSummary, replayed: true, toolCallId: call.id };
}

module.exports = { replayOutcome };
