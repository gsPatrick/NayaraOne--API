'use strict';

const { Message } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { transitionDispatch } = require('../../../integrations/dispatch/dispatch.transition');
const { isMarketingPurpose } = require('./mc.essential');

const MOTIVO = 'Mensagem de marketing cancelada: o WhatsApp ficou fora além do prazo da fila e uma campanha atrasada não deve ser enviada fora de hora.';

/**
 * Item da fila vencido (queue_max_age_h, M9-D226) no WhatsApp (M9-D227 3.1 item 3): mensagem de marketing é CANCELADA (envio e mensagem do CRM CANCELLED, com o motivo em português) em vez de
 * virar tarefa manual; a essencial devolve null e segue para a tarefa do responsável pelo atendimento. Devolve { handled: true } quando cancelou.
 */
async function handleAgedMessage(ctx, item, _policy, _now, transaction) {
  const message = await Message.findOne({ where: { dispatchId: item.id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message || !isMarketingPurpose(message.purpose) || message.deliveryStatus !== 'QUEUED') return null;
  await transitionDispatch(ctx, item.id, 'CANCELLED', {}, { motivo: MOTIVO }, transaction);
  await message.update({ status: 'CANCELLED', deliveryStatus: 'CANCELLED', failureReason: MOTIVO.slice(0, 240) }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'crm.message.cancelled_contingency_expired', entityType: 'Message', entityId: message.id,
    beforeJson: { deliveryStatus: 'QUEUED' }, afterJson: { deliveryStatus: 'CANCELLED', dispatchId: item.id }, reason: MOTIVO,
  }, transaction);
  return { handled: true, cancelled: true };
}

module.exports = { handleAgedMessage, MOTIVO };
