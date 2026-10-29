'use strict';

const { registerEventConsumer } = require('../../../../engines/events/consumers');
const { createTriggeredDraft } = require('./triggers.create');

/**
 * M9-D409 — consumidores dos eventos de origem. Cada um só gera RASCUNHO e é idempotente pelo id do evento do outbox. Eventos:
 * property.published (NEW_PROPERTY), property.price.changed com queda (PRICE_REDUCTION), property.sold e property.rented
 * (SOLD_RENTED) e keys.delivered (POST_SALE: o livro chama de contract.keys_delivered; o evento real do Jurídico é keys.delivered).
 */
const CONSUMER = 'marketing.content.type_triggers';

const tenantOf = (event) => ({ groupId: event.groupId, companyId: event.companyId });
const payloadOf = (event) => event.payloadJson || {};

const fromProperty = (type) => (event, transaction) =>
  createTriggeredDraft({ type, sourceEntityType: 'property', sourceEntityId: event.aggregateId, triggerEventId: event.id }, tenantOf(event), transaction);

async function onPriceChanged(event, transaction) {
  const { propertyId, oldPrice, newPrice } = payloadOf(event);
  if (!propertyId) return { created: false, skipped: 'EVENT_WITHOUT_PROPERTY' };
  const { reductionPercent } = require('./priceReduction');
  if (!reductionPercent(oldPrice, newPrice).isReduction) return { created: false, skipped: 'NOT_A_REDUCTION' }; // só queda
  return createTriggeredDraft({ type: 'PRICE_REDUCTION', sourceEntityType: 'property', sourceEntityId: propertyId, triggerEventId: event.id }, tenantOf(event), transaction);
}

async function onKeysDelivered(event, transaction) {
  const { deliveredToPersonId } = payloadOf(event);
  if (!deliveredToPersonId) return { created: false, skipped: 'EVENT_WITHOUT_PERSON' };
  return createTriggeredDraft({ type: 'POST_SALE', sourceEntityType: 'person', sourceEntityId: deliveredToPersonId, triggerEventId: event.id }, tenantOf(event), transaction);
}

const HANDLERS = Object.freeze({
  'property.published': fromProperty('NEW_PROPERTY'),
  'property.price.changed': onPriceChanged,
  'property.sold': fromProperty('SOLD_RENTED'),
  'property.rented': fromProperty('SOLD_RENTED'),
  'keys.delivered': onKeysDelivered,
});

for (const [eventType, handler] of Object.entries(HANDLERS)) registerEventConsumer(eventType, CONSUMER, handler);

module.exports = { CONSUMER, HANDLERS, onPriceChanged, onKeysDelivered };
