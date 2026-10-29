'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo real_estate (Transactional Outbox), seguindo
// exatamente o mesmo padrão de src/features/crm/opportunityEvents.service.js.

async function publishPropertyCreated(property, transaction) {
  return publishDomainEvent(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      aggregateType: 'Property',
      aggregateId: property.id,
      eventType: 'property.created',
      payload: { id: property.id, internalCode: property.internalCode, propertyType: property.propertyType },
      idempotencyKey: `property.created:${property.id}`,
    },
    transaction
  );
}

async function publishPropertyOfferCreated(offer, transaction) {
  return publishDomainEvent(
    {
      groupId: offer.groupId,
      companyId: offer.companyId,
      aggregateType: 'PropertyOffer',
      aggregateId: offer.id,
      eventType: 'property.offer.created',
      payload: { id: offer.id, propertyId: offer.propertyId, offerType: offer.offerType, status: offer.status },
      idempotencyKey: `property.offer.created:${offer.id}`,
    },
    transaction
  );
}

async function publishPropertyPublished(property, transaction) {
  return publishDomainEvent(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      aggregateType: 'Property',
      aggregateId: property.id,
      eventType: 'property.published',
      payload: { id: property.id, publicationStatus: property.publicationStatus },
      idempotencyKey: `property.published:${property.id}:${Date.now()}`,
    },
    transaction
  );
}

async function publishPropertyPriceChanged(priceHistory, transaction, propertyId = null) {
  return publishDomainEvent(
    {
      groupId: priceHistory.groupId,
      companyId: priceHistory.companyId,
      aggregateType: 'PropertyOffer',
      aggregateId: priceHistory.offerId,
      eventType: 'property.price.changed',
      payload: {
        offerId: priceHistory.offerId,
        propertyId,
        oldPrice: priceHistory.oldPrice,
        newPrice: priceHistory.newPrice,
        reasonCode: priceHistory.reasonCode,
      },
      idempotencyKey: `property.price.changed:${priceHistory.id}`,
    },
    transaction
  );
}

// Caderno (seção 17, "Eventos mínimos"): property.updated — faltava.
async function publishPropertyUpdated(property, transaction) {
  return publishDomainEvent(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      aggregateType: 'Property',
      aggregateId: property.id,
      eventType: 'property.updated',
      payload: { id: property.id, internalCode: property.internalCode, propertyType: property.propertyType },
      idempotencyKey: `property.updated:${property.id}:${Date.now()}`,
    },
    transaction
  );
}

// M9-D409: imóvel vendido ou alugado (availabilityStatus passou a SOLD / RENTED). O payload não leva comprador, locatário nem valor.
function publishPropertyAvailabilityEvent(eventType, property, transaction) {
  return publishDomainEvent(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      aggregateType: 'Property',
      aggregateId: property.id,
      eventType,
      payload: { id: property.id, availabilityStatus: property.availabilityStatus },
      idempotencyKey: `${eventType}:${property.id}:${Date.now()}`,
    },
    transaction
  );
}

const publishPropertySold = (property, transaction) => publishPropertyAvailabilityEvent('property.sold', property, transaction);
const publishPropertyRented = (property, transaction) => publishPropertyAvailabilityEvent('property.rented', property, transaction);

module.exports = {
  publishPropertySold,
  publishPropertyRented,
  publishPropertyCreated,
  publishPropertyOfferCreated,
  publishPropertyPublished,
  publishPropertyPriceChanged,
  publishPropertyUpdated,
};
