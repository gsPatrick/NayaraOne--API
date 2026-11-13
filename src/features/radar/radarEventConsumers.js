'use strict';

const { PropertyRadar } = require('../../models');
const { registerEventConsumer } = require('../../engines/events/consumers');
const { consumeInboundEvent } = require('../../engines/events/inbox');
const { runRadarMatching, runMatchingForProperty } = require('./radarMatchRun.service');

/**
 * CRMX-007 (livro §2 "Radar automático — Novo imóvel ou novo cliente pode disparar matching por eventos"; §13; §17
 * `crm.radar.match.created`; Guia §9 idempotência por criteria_version/fingerprint; CRM-TS-010 "Mesmo match reprocessado — Não
 * duplica"). O matching acontece no DESPACHO do outbox, não na requisição que mudou o dado:
 *  - lado do cliente: `crm.radar.created` / `crm.radar.updated` (radar novo ou alterado) e `person.created` (cliente novo que já
 *    nasce com radar) -> roda o(s) radar(es) ACTIVE contra os imóveis com oferta ativa;
 *  - lado do imóvel: `property.offer.created`, `property.offer.status.changed`, `property.price.changed` e `property.updated` -> roda
 *    os radares ACTIVE da empresa contra ESTE imóvel.
 * Idempotência em duas camadas: a caixa de entrada (consumidor + id do evento) aplica cada evento uma vez só, e por baixo dela o
 * INSERT ... ON CONFLICT na impressão digital dos critérios e a chave do `radar.matched` garantem que nenhum caminho (evento
 * reprocessado, job periódico, outro evento sobre o mesmo par) duplique match ou aviso. O job radarMatchingJob continua como rede
 * de segurança.
 */
const CONSUMER = 'crm.radar.matching';
const RADAR_EVENTS = ['crm.radar.created', 'crm.radar.updated'];
const PROPERTY_BY_PAYLOAD = ['property.offer.created', 'property.offer.status.changed', 'property.price.changed'];
const PROPERTY_BY_AGGREGATE = ['property.updated'];

const tenantOf = (event) => ({ groupId: event.groupId, companyId: event.companyId });

function once(event, transaction, work) {
  return consumeInboundEvent(
    { sourceId: CONSUMER, eventId: event.id, groupId: event.groupId, companyId: event.companyId, payload: { eventType: event.eventType }, transaction },
    () => work()
  );
}

async function runRadars(radars, event, transaction) {
  const summary = { radarsChecked: radars.length, newMatches: 0, storedMatches: 0 };
  for (const radar of radars) {
    const r = await runRadarMatching(radar, transaction, { origin: 'EVENT', sourceEventType: event.eventType });
    summary.newMatches += r.newMatches;
    summary.storedMatches += r.storedMatches;
  }
  return summary;
}

/** Radar criado/alterado: o radar do agregado, se ainda existir e estiver ACTIVE na empresa do evento. */
function onRadarEvent(event, transaction) {
  return once(event, transaction, async () => {
    const radar = await PropertyRadar.findOne({ where: { id: event.aggregateId, companyId: event.companyId, status: 'ACTIVE' }, transaction });
    return radar ? runRadars([radar], event, transaction) : null;
  });
}

/** Cliente novo: os radares ACTIVE dele (o cadastro que já cria pessoa e radar juntos). */
function onPersonCreated(event, transaction) {
  return once(event, transaction, async () => {
    const radars = await PropertyRadar.findAll({ where: { personId: event.aggregateId, companyId: event.companyId, status: 'ACTIVE' }, transaction });
    return radars.length ? runRadars(radars, event, transaction) : null;
  });
}

function onPropertyEvent(propertyIdOf) {
  return (event, transaction) => once(event, transaction, async () => {
    const propertyId = propertyIdOf(event);
    if (!propertyId) return null;
    return runMatchingForProperty(propertyId, tenantOf(event), transaction, event.eventType);
  });
}

const byPayload = onPropertyEvent((event) => (event.payloadJson || {}).propertyId || null);
const byAggregate = onPropertyEvent((event) => event.aggregateId);

RADAR_EVENTS.forEach((type) => registerEventConsumer(type, CONSUMER, onRadarEvent));
registerEventConsumer('person.created', CONSUMER, onPersonCreated);
PROPERTY_BY_PAYLOAD.forEach((type) => registerEventConsumer(type, CONSUMER, byPayload));
PROPERTY_BY_AGGREGATE.forEach((type) => registerEventConsumer(type, CONSUMER, byAggregate));

module.exports = { CONSUMER, RADAR_EVENTS, PROPERTY_BY_PAYLOAD, PROPERTY_BY_AGGREGATE, onRadarEvent, onPersonCreated };
