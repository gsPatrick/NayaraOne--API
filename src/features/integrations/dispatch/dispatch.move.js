'use strict';

const { createDispatch } = require('./dispatch.create');
const { transitionDispatch } = require('./dispatch.transition');

/**
 * moveQueuedDispatch — leva um envio que ainda está na fila para outra connection (M9-D226: troca para o fornecedor alternativo). O conteúdo aprovado NÃO
 * muda: o envio novo copia o snapshot já minimizado (e o hash, a finalidade e a chave de idempotência) do antigo, que é cancelado com o motivo.
 * Roda na transação de quem chama. Devolve o envio novo.
 */
async function moveQueuedDispatch(ctx, old, alternate, motivo, transaction) {
  const { dispatch } = await createDispatch(ctx, {
    connectionId: alternate.id, operation: old.operation, idempotencyKey: old.idempotencyKey, snapshot: old.payloadSnapshot, criticalityOp: old.criticalityOp,
    aggregateType: old.aggregateType, aggregateId: old.aggregateId, purpose: old.purpose, fieldsDropped: old.fieldsDropped, confirmationMode: old.confirmationMode,
    correlationId: old.correlationId, essential: old.essential === true, maxAttempts: old.maxAttempts,
  }, transaction);
  await transitionDispatch(ctx, old.id, 'CANCELLED', {}, { motivo }, transaction);
  return dispatch;
}

module.exports = { moveQueuedDispatch };
