'use strict';

const runs = require('../runs');
const { finalStateOf, failureOutcome } = require('./flow.outcome');
const { usageFields } = require('./flow.progress');
const { describeAvailable } = require('../failClosed');
const CLOSED_CODES = ['AI_FALLBACK_UNSAFE', 'AI_PROVIDER_UNAVAILABLE'];

/**
 * Qualquer erro depois do passo 1 finaliza o run (FAILED ou BLOCKED, com `finished_at`), com o custo já gasto. A reserva de orçamento
 * é liberada pelo próprio portão (`spendWithBudget` -> `release`) e a tool de escrita nunca fica sem linha em ai.tool_calls. Devolve a
 * resposta de falha com o HTTP e o código do erro; a transação NÃO é desfeita aqui (o chamador a confirma para o run ficar gravado).
 * Erro que não é do domínio (bug, banco) também finaliza o run quando possível e sobe como está.
 */
async function finalizeFailure(state, err) {
  const final = finalStateOf(err);
  try {
    await runs.finishRun(state.ctx, state.runId, {
      status: final.status, blockedReason: final.blockedReason, errorCode: String(final.errorCode).slice(0, 80), ...usageFields(state),
    }, state.transaction);
  } catch (closeErr) {
    if (err && err.isOperational) throw closeErr;
  }
  if (!err || !err.isOperational) throw err;
  const available = CLOSED_CODES.includes(err.code) ? describeAvailable(state) : null;
  return failureOutcome(state.runId, err, final, { trace: state.trace.spans, notices: state.notices, ...(available ? { available } : {}) });
}

module.exports = { finalizeFailure };
