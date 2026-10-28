'use strict';

const { govError } = require('../../governance.errors');
const construction = require('./construction.source');
const guarantee = require('./guarantee.source');

/**
 * Mapeamento evento de origem -> item do calendário para as fontes CONSTRUCTION e GUARANTEE (M9-D803). Função pura: o projetor
 * (M9-D802) chama `mapSourceEvent` e aplica `items` (UPSERT) e `transitions` (matriz de M9-D802 §3.2.1).
 *   event: { id, eventType, companyId, occurredAt, payload }   ctx: { companyId, severityMap }
 */
const EVENT_MAPPERS = { ...construction.EVENT_MAPPERS, ...guarantee.EVENT_MAPPERS };
const SOURCE_EVENT_TYPES = Object.freeze(Object.keys(EVENT_MAPPERS));

function mapSourceEvent(event, ctx = {}) {
  const mapper = EVENT_MAPPERS[event && event.eventType];
  if (!mapper) {
    throw govError(422, 'GOV_CALENDAR_EVENT_UNKNOWN', 'Tipo de evento sem origem conhecida no calendário.', { eventType: event && event.eventType });
  }
  if (ctx.companyId && event.companyId !== ctx.companyId) {
    throw govError(403, 'GOV_CALENDAR_TENANT_MISMATCH', 'O evento pertence a outra empresa e foi descartado.', { eventType: event.eventType });
  }
  return mapper(event.payload || {}, { ...ctx, event });
}

module.exports = { mapSourceEvent, SOURCE_EVENT_TYPES, EVENT_MAPPERS, ...construction, ...guarantee };
