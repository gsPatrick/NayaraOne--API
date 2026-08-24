'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

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

module.exports = { publishRadarMatched };
