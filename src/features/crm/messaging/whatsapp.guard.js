'use strict';

const { Message } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { registerPreflight } = require('../../integrations/dispatch/worker/worker.hooks');
const { OPERATIONS } = require('./messaging.send');
const { readWhatsappParams } = require('./whatsapp.params');
const { consentAllowed } = require('./whatsapp.consent');

const SEND_OPERATIONS = Object.values(OPERATIONS);
const MOTIVO = 'O contato revogou o consentimento antes do envio: a mensagem foi cancelada.';

/**
 * Consentimento conferido DE NOVO no momento do envio (M9-D230 3.2): a mensagem pode ter ficado na fila enquanto o contato pediu para sair. Se o consentimento deixou de valer, o envio vai a
 * CANCELLED (sem erro HTTP, não há requisição em andamento), a mensagem do CRM fica CANCELLED com o motivo em português e a auditoria registra; nunca é tentado de novo.
 */
async function consentPreflight({ dispatch, transaction }) {
  if (dispatch.aggregateType !== 'Message' || !SEND_OPERATIONS.includes(dispatch.operation)) return null;
  const message = await Message.findOne({ where: { id: dispatch.aggregateId, companyId: dispatch.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message || message.direction !== 'OUTBOUND' || message.deliveryStatus !== 'QUEUED') return null;
  const params = await readWhatsappParams({ groupId: dispatch.groupId, companyId: dispatch.companyId }, transaction);
  if (await consentAllowed(message.personId, message.purpose, params, transaction)) return null;
  await message.update({ status: 'CANCELLED', deliveryStatus: 'CANCELLED', failureReason: MOTIVO }, { transaction });
  await registrarAuditoria({
    groupId: message.groupId, companyId: message.companyId, actorUserId: null, action: 'crm.message.cancelled_no_consent', entityType: 'Message', entityId: message.id,
    afterJson: { dispatchId: dispatch.id, deliveryStatus: 'CANCELLED' }, reason: MOTIVO,
  }, transaction);
  return { cancel: { code: 'INTEGRATION_MESSAGING_NO_CONSENT', message: MOTIVO } };
}

let installed = false;
function installConsentGuard() {
  if (installed) return;
  installed = true;
  registerPreflight(consentPreflight);
}

module.exports = { installConsentGuard, consentPreflight };
