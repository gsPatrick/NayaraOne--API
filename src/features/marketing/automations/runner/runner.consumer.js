'use strict';

const { registerEventConsumer } = require('../../../../engines/events/consumers');
const { TRIGGER_EVENTS } = require('../catalog');
const { resolveSubject } = require('./runner.subject');
const { processEvent } = require('./runner.service');
const { CONSUMER_NAME } = require('./runner.constants');

/** Do evento do outbox para a entrada do runner: eventId do outbox, sujeito do payload/agregado, empresa e correlationId do evento. */
const inputOf = (event) => ({
  eventId: event.id, eventType: event.eventType, subject: resolveSubject(event), tenant: { groupId: event.groupId, companyId: event.companyId },
  payload: event.payloadJson || {}, correlationId: event.correlationId || undefined,
});

/** Passo 1: o runner consome do outbox todo evento do catálogo de gatilhos (um registro por evento; idempotente pelo inbox). */
/** Evento sem id (não vem do outbox) não tem como ser deduplicado: o runner o ignora. */
const handler = async (event, transaction) => (event && event.id ? processEvent(inputOf(event), transaction) : null);

function registerRunnerConsumers() {
  for (const eventType of TRIGGER_EVENTS) registerEventConsumer(eventType, CONSUMER_NAME, handler);
}

const consumedEventTypes = () => [...TRIGGER_EVENTS];

module.exports = { registerRunnerConsumers, consumedEventTypes, inputOf };
