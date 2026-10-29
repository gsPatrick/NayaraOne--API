'use strict';

const { registerEventConsumer } = require('../../../../engines/events/consumers');
const { SOURCE_EVENT_TYPES } = require('../sources');
const { projectEvent, CONSUMER } = require('./calendar.projector');

/** Liga o projetor ao outbox: um consumidor por tipo de evento de origem mapeado (as 10 fontes). Idempotente (registro por nome). */
function install() {
  for (const eventType of SOURCE_EVENT_TYPES) registerEventConsumer(eventType, CONSUMER, projectEvent);
  return SOURCE_EVENT_TYPES;
}

module.exports = { install };
