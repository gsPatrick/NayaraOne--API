'use strict';

const { Message } = require('../../../../../models');
const { createMessage, updateMessageStatus } = require('../../../../crm/messages.service');
const { registrarAuditoria } = require('../../../../../engines/audit/auditLog.service');

const STATUS_TEXT = Object.freeze({
  FAILED: 'O canal não aceitou a mensagem.',
  QUEUED: 'O canal não respondeu agora: a mensagem aguarda nova tentativa.',
  UNKNOWN: 'Resultado incerto do canal: confirme pela chave de idempotência antes de repetir.',
  EXPIRED: 'A mensagem passou do prazo da fila e foi cancelada sem ser enviada.',
});

/** Texto que fica no histórico do CRM: o e-mail guarda o assunto na primeira linha. */
const historyBody = (message) => (message.subject ? `Assunto: ${message.subject}\n\n${message.text}` : message.text);

/**
 * Grava a mensagem automática no CRM (crm.messages): sempre com a finalidade (o cap e o cooldown da M9-D416 contam por ela), a action_key (replay devolve a
 * mesma linha) e o status que o canal confirmou (SENT, nunca DELIVERED por conta própria). Falha grava FAILED/QUEUED/UNKNOWN com o motivo.
 */
async function recordOutbound({ tenant, input, message, status, providerRef, reason }, transaction) {
  const row = await createMessage({
    groupId: tenant.groupId, companyId: tenant.companyId, personId: input.personId, opportunityId: input.opportunityId, channel: input.channel, direction: 'OUTBOUND', authorType: 'NAY',
    body: historyBody(message), purpose: input.purpose, actionKey: input.actionKey, externalMessageId: providerRef || null, deliveryStatus: status,
  }, null, transaction);
  if (reason) await Message.update({ failureReason: String(reason).slice(0, 300) }, { where: { id: row.id }, transaction });
  return row;
}

/** Atualiza o status da linha existente (reenvio de QUEUED/UNKNOWN). */
async function moveOutbound(row, { status, providerRef, reason }, transaction) {
  await updateMessageStatus(row.id, status, null, transaction, { fromProvider: true });
  const patch = { ...(providerRef ? { externalMessageId: providerRef } : {}), failureReason: reason ? String(reason).slice(0, 300) : null };
  await Message.update(patch, { where: { id: row.id }, transaction });
  return Message.findByPk(row.id, { transaction });
}

const audit = (tenant, action, entityType, entityId, afterJson, reason, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action, entityType, entityId, beforeJson: null, afterJson, reason,
}, transaction);

module.exports = { recordOutbound, moveOutbound, audit, STATUS_TEXT, historyBody };
