'use strict';

const { Message, CrmConversation } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const dispatchService = require('../../../integrations/dispatch/enqueue/dispatch.service');
const { registerPreflight } = require('../../../integrations/dispatch/worker/worker.hooks');
const { readWhatsappParams } = require('../whatsapp.params');
const { assertSessionWindow } = require('../whatsapp.conversation');
const { readContingencyMessagingParams } = require('./mc.params');

const FREE_FORM_OPERATIONS = ['sendText', 'sendMedia'];
const CODE = 'INTEGRATION_MESSAGING_OUTSIDE_SESSION_WINDOW';
const SEM_MODELO = 'A janela de 24 horas venceu enquanto a mensagem esperava na fila e não há modelo aprovado para reenviá-la: uma pessoa precisa ligar para o cliente.';

const windowClosed = (conversation, wa, now) => {
  try { assertSessionWindow(conversation, wa, now); return false; } catch { return true; }
};

/** Modelo de contingência da connection: aprovado, com 0 ou 1 variável (o nome do contato). */
function usableTemplate(connection, name) {
  const modelos = Array.isArray((connection.configJson || {}).templates) ? connection.configJson.templates : [];
  const m = modelos.find((x) => x && x.name === name && x.approved === true);
  const vars = m ? (Array.isArray(m.variables) ? m.variables.length : Number(m.variables) || 0) : null;
  return m && vars !== null && vars <= 1 ? { ...m, vars } : null;
}

/**
 * Mensagem que esperou na fila além da janela de atendimento (M9-D227 3.1 item 4): no momento do envio o texto livre não vale mais. Com o modelo de contingência configurado
 * (`integration.whatsapp.expired_template_name`) e aprovado na connection, a mensagem VIRA o modelo: um envio novo de modelo no lugar do de texto (o antigo fecha em CANCELLED). Sem
 * modelo utilizável, a mensagem fica CANCELLED com o motivo e a tarefa do responsável sai pelo fluxo de contingência (liga para o cliente).
 */
async function windowPreflight({ dispatch, connection, now, transaction }) {
  if (dispatch.aggregateType !== 'Message' || !FREE_FORM_OPERATIONS.includes(dispatch.operation)) return null;
  const message = await Message.findOne({ where: { id: dispatch.aggregateId, companyId: dispatch.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message || message.direction !== 'OUTBOUND' || message.deliveryStatus !== 'QUEUED' || message.dispatchId !== dispatch.id) return null;
  const ctx = { groupId: dispatch.groupId, companyId: dispatch.companyId };
  const wa = await readWhatsappParams(ctx, transaction);
  const conversa = message.conversationId ? await CrmConversation.findByPk(message.conversationId, { transaction }) : null;
  if (!conversa || !windowClosed(conversa, wa, now)) return null; // sem conversa interna não há janela a conferir: o enfileiramento já exigiu a regra
  const params = await readContingencyMessagingParams(ctx, transaction);
  const modelo = params.expiredTemplateName ? usableTemplate(connection, params.expiredTemplateName) : null;
  const snapshot = dispatch.payloadSnapshot || {};
  if (!modelo || !snapshot.to) {
    await message.update({ status: 'CANCELLED', deliveryStatus: 'CANCELLED', failureReason: SEM_MODELO.slice(0, 240) }, { transaction });
    await registrarAuditoria({ groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'crm.message.cancelled_window_expired', entityType: 'Message', entityId: message.id, afterJson: { dispatchId: dispatch.id }, reason: SEM_MODELO }, transaction);
    return { cancel: { code: CODE, message: SEM_MODELO } };
  }
  const { dispatch: novo } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation: 'sendTemplate', aggregateType: 'Message', aggregateId: message.id, idempotencyKey: `crm-message:${message.id}:modelo`,
    payload: { to: snapshot.to, templateName: modelo.name, ...(modelo.language ? { language: modelo.language } : {}), ...(modelo.vars === 1 ? { templateVars: [snapshot.recipientName || 'cliente'] } : {}), ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}) },
    transaction,
  });
  await message.update({ dispatchId: novo.id }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'crm.message.converted_to_template', entityType: 'Message', entityId: message.id,
    beforeJson: { dispatchId: dispatch.id, operation: dispatch.operation }, afterJson: { dispatchId: novo.id, operation: 'sendTemplate', templateName: modelo.name },
    reason: 'A janela de atendimento venceu enquanto a mensagem esperava na fila: ela foi reenviada como modelo aprovado.',
  }, transaction);
  return { cancel: { code: 'INTEGRATION_MESSAGING_CONVERTED_TO_TEMPLATE', message: 'Mensagem convertida em modelo aprovado: a janela de atendimento venceu na fila.' } };
}

let installed = false;
function installWindowGuard() {
  if (installed) return;
  installed = true;
  registerPreflight(windowPreflight);
}

module.exports = { installWindowGuard, windowPreflight, usableTemplate };
