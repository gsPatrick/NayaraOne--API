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

async function publishPropertyPriceChanged(priceHistory, transaction) {
  return publishDomainEvent(
    {
      groupId: priceHistory.groupId,
      companyId: priceHistory.companyId,
      aggregateType: 'PropertyOffer',
      aggregateId: priceHistory.offerId,
      eventType: 'property.price.changed',
      payload: {
        offerId: priceHistory.offerId,
        oldPrice: priceHistory.oldPrice,
        newPrice: priceHistory.newPrice,
        reasonCode: priceHistory.reasonCode,
      },
      idempotencyKey: `property.price.changed:${priceHistory.id}`,
    },
    transaction
  );
}

module.exports = {
  publishPropertyCreated,
  publishPropertyOfferCreated,
  publishPropertyPublished,
  publishPropertyPriceChanged,
};
