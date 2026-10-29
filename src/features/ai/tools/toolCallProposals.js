'use strict';

/**
 * Fechamento da chamada PROPOSED pela decisão humana da recomendação (M9-D006 3, dona do mapeamento: M9-D019). A chamada NÃO é
 * reexecutada: o ApprovalService executa pelo application service com idempotencyKey = recommendation_id, e aqui só se registra o
 * desfecho. EXECUTED -> SUCCEEDED; EXECUTION_FAILED -> FAILED; REJECTED -> CANCELLED_BY_HUMAN; STALE -> BLOCKED (blocked_reason
 * STALE). Não existe expiração por tempo: PROPOSED fica até a decisão (EXPIRED não é estado da chamada).
 */
const { AiToolCall } = require('../../../models');
const E = require('./toolCalls.errors');
const C = require('./toolCalls.constants');
const { toToolCall } = require('./toolCalls.mapper');
const { auditToolCall, publishToolCallEvent } = require('./toolCallEvents');
const { countBlocked } = require('./toolCallsBlockedCounter');

async function settleProposedToolCall(ctx, { proposalId, recommendationStatus, errorCode } = {}, transaction) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
  const outcome = Object.prototype.hasOwnProperty.call(C.PROPOSAL_OUTCOMES, recommendationStatus) ? C.PROPOSAL_OUTCOMES[recommendationStatus] : null;
  if (!outcome) throw E.invalid('A decisão da recomendação não fecha uma chamada de ferramenta.', { recommendationStatus: String(recommendationStatus) });
  try {
    const row = await AiToolCall.findOne({ where: { proposalId: proposalId || null, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound();
    if (row.status === outcome.status) return toToolCall(row); // repetir a mesma decisão não muda nada
    if (C.FINAL_STATUSES.includes(row.status)) throw E.immutable(); // já decidida de outro jeito: não vira de outro (recusa antes de tocar o banco)
    if (row.status !== 'PROPOSED') throw E.badTransition(row.status, outcome.status);
    const before = toToolCall(row);
    const set = { status: outcome.status, updatedBy: ctx.userId || null, latencyMs: row.latencyMs };
    if (outcome.blockedReason) set.blockedReason = outcome.blockedReason;
    if (outcome.status === 'FAILED') set.resultSummary = { error: String(errorCode || 'EXECUTION_FAILED').slice(0, 120) };
    await row.update(set, { transaction });
    await row.reload({ transaction });
    const call = toToolCall(row);
    await auditToolCall(ctx, 'ai.tool_call.state_changed', call, before, `Chamada de ferramenta da NAY: ${before.status} para ${call.status} pela decisão da recomendação.`, transaction);
    if (call.status === 'BLOCKED') countBlocked(outcome.blockedReason);
    if (call.status === 'BLOCKED') await publishToolCallEvent(ctx, C.EVENT_BLOCKED, call, { capability: 'STALE' }, transaction);
    return call;
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

module.exports = { settleProposedToolCall };
