'use strict';

const { applyTransition } = require('../dispatch.transition');
const { reportDispatchError, publishFailed, MENSAGENS } = require('./retry.report');

/**
 * Esgotou as tentativas: DEAD_LETTER com erro HIGH e aviso ao domínio. De SENDING o caminho da máquina de estados da D205 passa por
 * RETRY_WAIT (a tabela não leva SENDING direto à fila morta); de UNKNOWN vai direto.
 */
async function sendToDeadLetter(ctx, dispatch, cls, httpStatus, transaction) {
  const patch = { lastErrorClass: cls.class, lastErrorCode: cls.code, lastHttpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined };
  const motivo = 'ATTEMPTS_EXHAUSTED'; // M9-D215: o motivo fica no envio; UNKNOWN_UNRESOLVED é da reconciliação (reconcile.deadLetter.js)
  if (dispatch.status === 'SENDING') await applyTransition(ctx, dispatch, 'RETRY_WAIT', patch, { motivo: `Tentativas esgotadas (${dispatch.attempts} de ${dispatch.maxAttempts}).` }, transaction);
  await applyTransition(ctx, dispatch, 'DEAD_LETTER', { ...patch, deadLetterReason: motivo }, { motivo: 'Tentativas esgotadas: fila morta.' }, transaction);
  await reportDispatchError(ctx, dispatch, { errorClass: cls.class, errorCode: cls.code, severity: 'HIGH', message: MENSAGENS.DEAD_LETTER, httpStatus }, transaction);
  await publishFailed(ctx, dispatch, { errorClass: cls.class, errorCode: cls.code, status: 'DEAD_LETTER' }, transaction);
  return dispatch;
}

module.exports = { sendToDeadLetter };
