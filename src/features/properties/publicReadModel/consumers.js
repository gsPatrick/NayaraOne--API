'use strict';

const { registerEventConsumer } = require('../../../engines/events/consumers');
const { syncPublicPropertyReadModel } = require('./readModel.sync');

/**
 * Eventos que mexem no que é público (M9-D231): o read model recalcula o imóvel afetado. Os eventos de oferta e de preço
 * trazem o imóvel em `propertyId`; os demais têm o imóvel como agregado.
 */
const NAME = 'properties.public_read_model';
const BY_AGGREGATE = ['property.created', 'property.updated', 'property.published', 'property.sold', 'property.rented', 'property.public_source.changed'];
const BY_PAYLOAD = ['property.price.changed', 'property.offer.created'];

const tenantOf = (event) => ({ groupId: event.groupId, companyId: event.companyId });

function onAggregateEvent(event, transaction) {
  return syncPublicPropertyReadModel(event.aggregateId, tenantOf(event), transaction);
}

async function onPayloadEvent(event, transaction) {
  const propertyId = event.payloadJson && event.payloadJson.propertyId;
  if (!propertyId) return { status: 'SKIPPED' };
  return syncPublicPropertyReadModel(propertyId, tenantOf(event), transaction);
}

BY_AGGREGATE.forEach((type) => registerEventConsumer(type, NAME, onAggregateEvent));
BY_PAYLOAD.forEach((type) => registerEventConsumer(type, NAME, onPayloadEvent));

module.exports = { NAME, BY_AGGREGATE, BY_PAYLOAD, onAggregateEvent, onPayloadEvent };
