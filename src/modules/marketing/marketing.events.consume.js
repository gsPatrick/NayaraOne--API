'use strict';

const { IntegrationInbox } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Consumo idempotente de um evento de Marketing (entrega pelo menos uma vez): por (consumidor, eventId do envelope) o handler roda
 * no máximo uma vez. Usa a transação do chamador (tenant e RLS já definidos) num savepoint: se o handler falha, a marca de
 * "visto" é desfeita junto e o evento pode ser reentregue. `row` é a linha do outbox entregue ao consumidor.
 */
async function consumeMarketingEvent(row, consumerName, handler, transaction) {
  const envelope = row && row.payloadJson;
  if (!envelope || !envelope.eventId || !consumerName || typeof handler !== 'function' || !transaction) {
    throw AppError.internal('consumeMarketingEvent requer evento com envelope, consumidor, handler e transação.', 'MKT_EVENT_CONSUMER_INCOMPLETE');
  }
  const idempotencyKey = `${consumerName}:${envelope.eventId}`.slice(0, 128);
  const seen = await IntegrationInbox.findOne({ where: { idempotencyKey }, transaction });
  if (seen) return { processed: false, duplicate: true };
  const sequelize = IntegrationInbox.sequelize;
  await sequelize.transaction({ transaction }, async (savepoint) => {
    await IntegrationInbox.create({
      groupId: envelope.groupId, companyId: envelope.companyId, consumerName, eventId: envelope.eventId,
      idempotencyKey, payloadJson: envelope, status: 'PROCESSED',
    }, { transaction: savepoint });
    await handler(envelope, savepoint);
  });
  return { processed: true, duplicate: false };
}

module.exports = { consumeMarketingEvent };
