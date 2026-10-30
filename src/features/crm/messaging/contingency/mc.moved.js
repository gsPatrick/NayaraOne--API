'use strict';

const { Message } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

/**
 * O envio da mensagem trocou de connection (outro fornecedor de mensagens, M9-D226): a mensagem do CRM passa a apontar para o envio e a connection novos e a conversa
 * mostra "enviada por canal alternativo" (alternate_channel = código do outro fornecedor). Roda NA MESMA transação da troca: o observador do worker acha a mensagem pelo envio novo.
 */
async function onMessageDispatchMoved(ctx, { from, to, alternate }, transaction) {
  const message = await Message.findOne({ where: { dispatchId: from.id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message) return null;
  await message.update({ dispatchId: to.id, connectionId: alternate.id, alternateChannel: String(alternate.providerCode).slice(0, 48), alternateRef: to.id, alternateAt: new Date() }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'crm.message.sent_via_alternate_provider', entityType: 'Message', entityId: message.id,
    beforeJson: { dispatchId: from.id, connectionId: from.connectionId }, afterJson: { dispatchId: to.id, connectionId: alternate.id, alternateChannel: alternate.providerCode },
    reason: 'WhatsApp principal fora: a mensagem seguiu pelo outro fornecedor de mensagens, marcada como enviada por canal alternativo.',
  }, transaction);
  return message;
}

module.exports = { onMessageDispatchMoved };
