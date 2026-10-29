'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');

const EVENTS = Object.freeze({ CONFIRMED: 'integration.dispatch.confirmed', FAILED: 'integration.dispatch.failed' });

/**
 * Publica um evento interno do envio no outbox, na MESMA transação da mudança de estado, uma vez só (chave = tipo + id do envio).
 * Leva só ids e códigos: o domínio reage ao evento e nunca recebe o conteúdo enviado.
 */
async function publishDispatchEvent(ctx, dispatch, eventType, extra, transaction) {
  return publishDomainEvent({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    aggregateType: dispatch.aggregateType || 'IntegrationDispatch',
    aggregateId: dispatch.aggregateId || dispatch.id,
    eventType,
    payload: {
      dispatchId: dispatch.id, aggregate: { type: dispatch.aggregateType || null, id: dispatch.aggregateId || null }, operation: dispatch.operation,
      providerCode: dispatch.providerCode, externalResourceId: dispatch.externalResourceId || null, ...extra,
    },
    idempotencyKey: `${eventType}:${dispatch.id}`,
    correlationId: dispatch.correlationId || undefined,
  }, transaction);
}

module.exports = { EVENTS, publishDispatchEvent };
