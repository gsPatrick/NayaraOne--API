'use strict';

const { OutboxEvent } = require('../../models');
const AppError = require('../../utils/AppError');
const { getCurrentCorrelationId } = require('../../middlewares/correlationId.middleware');
const { DOMAINS } = require('../../features/integrations/registry/registry.constants');

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
 *
 * M9-D204: a `transaction` é OBRIGATÓRIA (INT-012: o evento nasce com o dado de negócio; sem
 * transação seria publicar fora dela). Evento com destino externo informa `targetDomain` (família
 * do catálogo de integrações) e, opcionalmente, `connectionId`; sem `targetDomain` o evento segue
 * para os consumidores internos como sempre. Republicar a mesma `idempotencyKey` é no-op: devolve
 * o evento já gravado.
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
    targetDomain,
    connectionId,
  } = event;

  if (!transaction) {
    throw AppError.internal('O evento precisa ser gravado na mesma transação do dado de negócio.', 'INTEGRATION_OUTBOX_TRANSACTION_REQUIRED');
  }

  if (!groupId || !companyId) {
    throw AppError.internal('publishDomainEvent requer groupId/companyId (contexto de tenant).', 'OUTBOX_TENANT_MISSING');
  }
  if (!aggregateType || !aggregateId || !eventType) {
    throw AppError.internal('publishDomainEvent requer aggregateType, aggregateId e eventType.', 'OUTBOX_EVENT_INCOMPLETE');
  }
  if (!idempotencyKey) {
    throw AppError.internal('publishDomainEvent requer idempotencyKey (FIN-004/ARC — idempotência obrigatória).', 'OUTBOX_IDEMPOTENCY_KEY_MISSING');
  }

  if (targetDomain !== undefined && targetDomain !== null && !DOMAINS.includes(targetDomain)) {
    throw AppError.badRequest('Domínio de destino do evento fora do catálogo de integrações.', 'INTEGRATION_OUTBOX_TARGET_DOMAIN_INVALID', { targetDomain });
  }

  const existente = await OutboxEvent.findOne({ where: { idempotencyKey }, transaction });
  if (existente) return existente;

  return OutboxEvent.create(
    {
      groupId,
      companyId,
      aggregateType,
      aggregateId,
      eventType,
      eventVersion: eventVersion || 1,
      payloadJson: payload || {},
      // TEC-08: se o chamador não informar explicitamente (a grande maioria não informa), usa
      // o correlationId da requisição HTTP em curso (AsyncLocalStorage, ver
      // correlationId.middleware.js) — liga automaticamente o evento à requisição que o
      // originou, sem precisar tocar cada um dos pontos que chamam publishDomainEvent.
      correlationId: correlationId || getCurrentCorrelationId(),
      causationId: causationId || null,
      idempotencyKey,
      classification: classification || null,
      targetDomain: targetDomain || null,
      connectionId: connectionId || null,
      occurredAt: new Date(),
      status: 'PENDING',
    },
    { transaction }
  );
}

module.exports = { publishDomainEvent };
