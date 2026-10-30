'use strict';

const repo = require('./review.repository');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { auditReview } = require('./review.audit');

const DELIVERED_STATES = ['DELIVERED', 'READ'];

/**
 * Status de entrega da mensagem do pedido (WhatsApp ou e-mail, vindo do webhook do canal): SENT passa a DELIVERED quando o canal confirma a entrega; falha de entrega marca o
 * pedido FAILED (não conta como pedido feito e não há reenvio automático). Mensagem que não é de um pedido de avaliação não muda nada.
 */
async function onDeliveryStatus({ tenant, messageId, status }, transaction) {
  const [found] = await sequelize.query('SELECT id FROM marketing.review_requests WHERE message_id = :m AND deleted_at IS NULL', { replacements: { m: messageId }, transaction, type: QueryTypes.SELECT });
  if (!found) return { updated: false };
  const row = await repo.findOne(found.id, transaction, true);
  let fields = null;
  if (DELIVERED_STATES.includes(status) && row.status === 'SENT') fields = { status: 'DELIVERED' };
  if (status === 'FAILED' && ['SENT', 'DELIVERED'].includes(row.status)) fields = { status: 'FAILED', errorCode: 'MKT_REVIEW_DELIVERY_FAILED' };
  if (!fields) return { updated: false };
  const after = await repo.update(row.id, fields, null, transaction);
  await auditReview(tenant, null, `marketing.review_request.${after.status.toLowerCase()}`, row, after, `Status de entrega do canal: ${status}.`, transaction);
  return { updated: true, status: after.status };
}

module.exports = { onDeliveryStatus };
