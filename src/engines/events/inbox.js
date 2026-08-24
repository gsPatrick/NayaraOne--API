'use strict';

const { sequelize, IntegrationInbox } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * consumeInboundEvent — handler de Inbox idempotente (03_MOTORES_TRANSVERSAIS.md §2.2/§2.6).
 * Garante que o mesmo evento (por `sourceId` + `eventId`, mapeados em
 * "integration"."integration_inbox".consumer_name/event_id, com `idempotency_key` UNIQUE)
 * nunca seja processado duas vezes por um mesmo consumidor — mesmo sob webhook duplicado,
 * retry, timeout ou reentrega do broker.
 *
 * Uso:
 *   await consumeInboundEvent({
 *     sourceId: 'webhook.provider-x',       // vira consumer_name
 *     eventId: externalEventUuid,           // vira event_id
 *     groupId, companyId,
 *     payload: rawWebhookBody,
 *   }, async () => {
 *     // handlerFn — lógica de negócio do consumo, roda no máximo 1x por (sourceId, eventId)
 *   });
 *
 * Retorna `{ processed: boolean, duplicate: boolean }`.
 */
async function consumeInboundEvent({ sourceId, eventId, groupId, companyId, payload }, handlerFn) {
  if (!sourceId || !eventId) {
    throw AppError.internal('consumeInboundEvent requer sourceId e eventId.', 'INBOX_EVENT_INCOMPLETE');
  }
  if (typeof handlerFn !== 'function') {
    throw AppError.internal('consumeInboundEvent requer handlerFn (função).', 'INBOX_HANDLER_MISSING');
  }
  if (!groupId || !companyId) {
    throw AppError.internal('consumeInboundEvent requer groupId/companyId (contexto de tenant).', 'INBOX_TENANT_MISSING');
  }

  const idempotencyKey = `${sourceId}:${eventId}`;

  return sequelize.transaction(async (transaction) => {
    const existing = await IntegrationInbox.findOne({ where: { idempotencyKey }, transaction });
    if (existing) {
      // Já visto antes — não reprocessa (deduplicação). PROCESSING também conta como duplicata
      // aqui de forma conservadora: evita reentrância concorrente do mesmo evento.
      return { processed: false, duplicate: true, status: existing.status };
    }

    const inboxRecord = await IntegrationInbox.create(
      {
        groupId,
        companyId,
        consumerName: sourceId,
        eventId,
        idempotencyKey,
        payloadJson: payload || null,
        status: 'PROCESSING',
      },
      { transaction }
    );

    try {
      await handlerFn(transaction);
      inboxRecord.status = 'PROCESSED';
      await inboxRecord.save({ transaction });
      return { processed: true, duplicate: false, status: 'PROCESSED' };
    } catch (err) {
      inboxRecord.status = 'FAILED';
      inboxRecord.deadLetterReason = err.message;
      await inboxRecord.save({ transaction });
      throw err;
    }
  });
}

module.exports = { consumeInboundEvent };
