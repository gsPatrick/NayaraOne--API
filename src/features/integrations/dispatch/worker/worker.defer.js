'use strict';

const { applyTransition } = require('../dispatch.transition');

/**
 * Devolve o envio (já em SENDING) a RETRY_WAIT para `until` SEM gastar tentativa: o contador volta ao valor anterior ao SENDING.
 * Serve ao circuito aberto, à conexão parada e à cota (M9-D214 3.2 item 2; M9-D218 3.2).
 */
async function deferDispatch(ctx, dispatch, until, reason, transaction) {
  return applyTransition(ctx, dispatch, 'RETRY_WAIT', { nextAttemptAt: until }, { refundAttempt: true, motivo: `Envio adiado sem gastar tentativa: ${reason}.` }, transaction);
}

module.exports = { deferDispatch };
