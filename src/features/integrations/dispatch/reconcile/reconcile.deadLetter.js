'use strict';

const { applyTransition } = require('../dispatch.transition');
const { publishDispatchEvent, EVENTS } = require('../dispatch.events');
const { reportDispatchError, MENSAGENS } = require('../retry/retry.report');

const REASON_UNRESOLVED = 'UNKNOWN_UNRESOLVED';

/**
 * Esgotou as consultas sem saber se o fornecedor executou (M9-D215 3.2): DEAD_LETTER com motivo UNKNOWN_UNRESOLVED, incidente CRITICAL e o
 * evento `integration.dispatch.needs_manual_review` para o domínio abrir a tarefa de conferir no extrato. NUNCA repete a operação: a
 * única saída da fila morta é o retry humano autorizado (D205/D250).
 */
async function sendUnresolvedToDeadLetter(ctx, row, { reconcileAttempts, trail }, transaction) {
  const unknownSince = row.unknownSince ? row.unknownSince.toISOString() : null;
  await applyTransition(ctx, row, 'DEAD_LETTER', { deadLetterReason: REASON_UNRESOLVED, reconcileAttempts }, { motivo: `Consultas esgotadas (${reconcileAttempts}) sem resposta conclusiva: revisão humana.` }, transaction);
  await reportDispatchError(ctx, row, { errorClass: 'UNKNOWN', errorCode: REASON_UNRESOLVED, severity: 'CRITICAL', message: MENSAGENS.UNKNOWN_UNRESOLVED, httpStatus: row.lastHttpStatus }, transaction);
  await publishDispatchEvent(ctx, row, EVENTS.NEEDS_MANUAL_REVIEW, { reason: REASON_UNRESOLVED, reconcileAttempts, unknownSince, lastStrategies: trail.map((t) => `${t.strategy}:${t.outcome}`) }, transaction);
  return row;
}

module.exports = { sendUnresolvedToDeadLetter, REASON_UNRESOLVED };
