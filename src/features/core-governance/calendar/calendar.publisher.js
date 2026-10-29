'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');

/**
 * Publicação dos eventos de origem que alimentam o projetor do Calendário (M9-D802 §3.1.1). Cada módulo de origem chama
 * `publishSourceEvent` DENTRO da transação da operação (Transactional Outbox: dado e evento no mesmo commit). Chave de idempotência
 * `<evento>:<id>:<versão>`: a versão é o lock_version da origem ou, sem ele, o instante da última atualização.
 */
function versionOf(entity) {
  if (entity.lockVersion !== undefined && entity.lockVersion !== null) return entity.lockVersion;
  const stamp = entity.updatedAt || entity.updated_at || new Date();
  return new Date(stamp).getTime();
}

function publishSourceEvent({ entity, aggregateType, eventType, payload, version }, transaction) {
  return publishDomainEvent({
    groupId: entity.groupId, companyId: entity.companyId, aggregateType, aggregateId: entity.id, eventType, payload: { id: entity.id, ...payload },
    idempotencyKey: `${eventType}:${entity.id}:${version !== undefined ? version : versionOf(entity)}`,
  }, transaction);
}

module.exports = { publishSourceEvent };
