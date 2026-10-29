'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');

/** O read model mudou: portais e site precisam sincronizar (consumido pelos adapters, M9-D232 e M9-D259). Sem dado pessoal. */
function publishPublicChanged({ property, publicCode, version, hash }, transaction) {
  return publishDomainEvent({
    groupId: property.groupId,
    companyId: property.companyId,
    aggregateType: 'Property',
    aggregateId: property.id,
    eventType: 'property.public.changed',
    payload: { propertyId: property.id, publicCode, readModelVersion: version },
    idempotencyKey: `property.public.changed:${property.id}:${version}:${hash.slice(0, 16)}`,
  }, transaction);
}

/** O imóvel saiu do read model (indisponível, despublicado, vendido, alugado ou excluído): é preciso despublicar nos fornecedores. */
function publishPublicUnpublish({ groupId, companyId, propertyId, publicCode, reasons }, transaction) {
  return publishDomainEvent({
    groupId,
    companyId,
    aggregateType: 'Property',
    aggregateId: propertyId,
    eventType: 'property.public.unpublish',
    payload: { propertyId, publicCode, reasons },
    idempotencyKey: `property.public.unpublish:${propertyId}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
  }, transaction);
}

module.exports = { publishPublicChanged, publishPublicUnpublish };
