'use strict';

/**
 * Porta entre o outbox e o Dispatch Service (M9-D214). O outbox não conhece fornecedor: ele só entrega
 * o evento com destino externo a quem se registrou aqui, DENTRO da transação do despacho, e o
 * Dispatch Service grava a linha integration.dispatches (com outbox_event_id). Nenhuma chamada externa
 * acontece nesta porta (INT-012).
 *
 * Contrato do enqueuer: async ({ companyId, groupId, domain, connectionId, operation, aggregateType,
 * aggregateId, payload, idempotencyKey, correlationId, outboxEventId, transaction }) => { dispatchId, status }.
 * Sem enqueuer registrado o evento com destino permanece PENDING (nada se perde).
 */
let enqueuer = null;

function registerDispatchEnqueuer(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerDispatchEnqueuer espera uma função.');
  enqueuer = fn;
}

function getDispatchEnqueuer() {
  return enqueuer;
}

function resetDispatchEnqueuer() {
  enqueuer = null;
}

/** Monta os argumentos do enqueuer a partir da linha do outbox. */
function buildEnqueueArgs(event, transaction) {
  return {
    companyId: event.companyId,
    groupId: event.groupId,
    domain: event.targetDomain,
    connectionId: event.connectionId || null,
    operation: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payloadJson,
    idempotencyKey: event.idempotencyKey,
    correlationId: event.correlationId || null,
    outboxEventId: event.id,
    transaction,
  };
}

module.exports = { registerDispatchEnqueuer, getDispatchEnqueuer, resetDispatchEnqueuer, buildEnqueueArgs };
