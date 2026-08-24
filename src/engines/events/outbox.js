'use strict';

const { OutboxEvent } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * publishDomainEvent — grava um evento de domínio em "integration"."outbox_events" NA MESMA
 * transação da operação de negócio que o originou (padrão Transactional Outbox —
 * 03_MOTORES_TRANSVERSAIS.md §2.1: "Se a transação falhar, domínio e evento falham juntos.
 * É proibido salvar o dado e depois tentar publicar diretamente no broker fora da
 * transação.").
 *
 * Uso obrigatório dentro de um service que já está de posse de uma `transaction` aberta por
 * `req.withTenantTransaction` (tenant.middleware.js):
 *
 *   await publishDomainEvent({
 *     groupId, companyId,
 *     aggregateType: 'Unit', aggregateId: unit.id,
 *     eventType: 'unit.created',
 *     payload: { id: unit.id, name: unit.name },
 *     idempotencyKey: `unit.created:${unit.id}`,
 *   }, transaction);
 *
 * `idempotencyKey` é obrigatória (coluna UNIQUE) — recomenda-se `<eventType>:<aggregateId>`
 * ou `<eventType>:<aggregateId>:<causationId>` quando o mesmo aggregate pode gerar o mesmo
 * eventType mais de uma vez de forma legítima.
 */
async function publishDomainEvent(event, transaction) {
  const {
    groupId,
    companyId,
    aggregateType,
    aggregateId,
    eventType,
    payload,
    idempotencyKey,
    correlationId,
    causationId,
    eventVersion,
    classification,
  } = event;

  if (!groupId || !companyId) {
    throw AppError.internal('publishDomainEvent requer groupId/companyId (contexto de tenant).', 'OUTBOX_TENANT_MISSING');
  }
  if (!aggregateType || !aggregateId || !eventType) {
    throw AppError.internal('publishDomainEvent requer aggregateType, aggregateId e eventType.', 'OUTBOX_EVENT_INCOMPLETE');
  }
  if (!idempotencyKey) {
    throw AppError.internal('publishDomainEvent requer idempotencyKey (FIN-004/ARC — idempotência obrigatória).', 'OUTBOX_IDEMPOTENCY_KEY_MISSING');
  }

  return OutboxEvent.create(
    {
      groupId,
      companyId,
      aggregateType,
      aggregateId,
      eventType,
      eventVersion: eventVersion || 1,
      payloadJson: payload || {},
      correlationId: correlationId || null,
      causationId: causationId || null,
      idempotencyKey,
      classification: classification || null,
      occurredAt: new Date(),
      status: 'PENDING',
    },
    { transaction }
  );
}

module.exports = { publishDomainEvent };
