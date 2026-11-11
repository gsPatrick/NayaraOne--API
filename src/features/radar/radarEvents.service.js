'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');
const { criteriaFingerprint, SCORING_VERSION } = require('./radarCriteria');

// Publicação dos domain events do módulo radar (Transactional Outbox), seguindo o mesmo
// padrão de src/features/properties/propertyEvents.service.js e
// src/features/crm/opportunityEvents.service.js.

/**
 * publishRadarMatched — evento de "novo match encontrado" para um radar, disparado pelo job
 * periódico (radarMatchingJob.js). `idempotencyKey` inclui o par radar+imóvel, então o mesmo
 * match nunca gera dois eventos mesmo que o job rode de novo antes do evento ser consumido —
 * é o próprio outbox (coluna idempotency_key UNIQUE) que garante isso.
 */
async function publishRadarMatched(radar, property, transaction) {
  return publishDomainEvent(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      aggregateType: 'PropertyRadar',
      aggregateId: radar.id,
      eventType: 'radar.matched',
      payload: { radarId: radar.id, personId: radar.personId, propertyId: property.id },
      idempotencyKey: `radar.matched:${radar.id}:${property.id}`,
    },
    transaction
  );
}

/**
 * CRMX-007 (livro §2 "Novo imóvel ou novo cliente pode disparar matching por eventos"): radar criado ou alterado publica o seu
 * evento no outbox, na mesma transação; o consumidor do Radar (radarEventConsumers.js) faz o matching no despacho. O payload leva
 * só ids, a impressão digital dos critérios e o status (nada da pessoa). A chave do `crm.radar.updated` inclui o instante da
 * alteração (PADRAO §2.7): cada alteração real é um evento; o reenvio da mesma alteração não duplica.
 */
function radarPayload(radar) {
  return {
    radarId: radar.id,
    personId: radar.personId,
    status: radar.status,
    criteriaFingerprint: criteriaFingerprint(radar.criteriaJson),
    criteriaVersion: SCORING_VERSION,
  };
}

function publishRadarCreated(radar, transaction) {
  return publishDomainEvent(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      aggregateType: 'PropertyRadar',
      aggregateId: radar.id,
      eventType: 'crm.radar.created',
      payload: radarPayload(radar),
      idempotencyKey: `crm.radar.created:${radar.id}`,
    },
    transaction
  );
}

function publishRadarUpdated(radar, transaction) {
  const at = new Date(radar.updatedAt || radar.get('updated_at') || Date.now()).getTime();
  return publishDomainEvent(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      aggregateType: 'PropertyRadar',
      aggregateId: radar.id,
      eventType: 'crm.radar.updated',
      payload: radarPayload(radar),
      idempotencyKey: `crm.radar.updated:${radar.id}:${at}`,
    },
    transaction
  );
}

module.exports = { publishRadarMatched, publishRadarCreated, publishRadarUpdated };
