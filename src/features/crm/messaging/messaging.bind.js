'use strict';

const { sequelize, Message } = require('../../../models');
const { registerCallObserver } = require('../../integrations/dispatch/worker/worker.hooks');
const { messagingStatus: { shouldApply, STATUS } } = require('../../integrations');
const { updateMessageStatus } = require('../messages.service');
const { PADRAO_ENTREGA } = require('./whatsapp.reasons');
const { OPERATIONS } = require('./messaging.send');

const SEND_OPERATIONS = Object.values(OPERATIONS);

/**
 * Liga a resposta do fornecedor à mensagem do CRM (M9-D229 3.2 itens 1 e 2): quando o envio é aceito, grava o id do fornecedor (`external_message_id`) e a connection, e a mensagem passa de
 * QUEUED a SENT. O HTTP 200 do envio prova só que o fornecedor ACEITOU a mensagem: mesmo que a resposta já traga um status mais adiantado, a mensagem fica em SENT e só vai a
 * DELIVERED ou READ por webhook ou consulta de status (M9-D230: nunca presume entrega). Roda num SAVEPOINT da transação do worker: falhar aqui nunca derruba o envio.
 */
async function bindSendResult({ dispatch, connection, response, transaction }) {
  const message = await Message.findOne({ where: { dispatchId: dispatch.id, companyId: dispatch.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  const externalId = response && response.externalResourceId;
  if (!message || !externalId) return;
  await message.update({ externalMessageId: String(externalId).slice(0, 128), connectionId: connection.id }, { transaction });
  const proximo = response.status === STATUS.FAILED ? STATUS.FAILED : STATUS.SENT;
  if (shouldApply(message.deliveryStatus, proximo)) {
    await updateMessageStatus(message.id, proximo, null, transaction, { fromProvider: true });
    if (proximo === STATUS.FAILED) await Message.update({ failureReason: PADRAO_ENTREGA }, { where: { id: message.id }, transaction }); // 200 com status final "failed": FAILED com o motivo (M9-D230 3.4)
  }
}

let installed = false;
/** Registra o observador uma vez por processo. */
function installMessageBinder() {
  if (installed) return;
  installed = true;
  registerCallObserver(async (args) => {
    const { dispatch, response, error } = args;
    if (error || !response || dispatch.aggregateType !== 'Message' || !SEND_OPERATIONS.includes(dispatch.operation)) return;
    try {
      await sequelize.transaction({ transaction: args.transaction }, (savepoint) => bindSendResult({ ...args, transaction: savepoint }));
    } catch { /* o savepoint desfez só a ligação; a mensagem segue QUEUED e o envio, SUBMITTED */ }
  });
}

module.exports = { installMessageBinder, bindSendResult };
