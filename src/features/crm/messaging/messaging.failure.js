'use strict';

const { Message } = require('../../../models');
const { registerEventConsumer } = require('../../../engines/events/consumers');
const { messagingStatus: { shouldApply, STATUS } } = require('../../integrations');
const { updateMessageStatus } = require('../messages.service');

const CONSUMER = 'crm.messaging.dispatch_failed';

/**
 * Envio que terminou em falha (`integration.dispatch.failed`, M9-D229 3.2 item 1 e M9-D220 3.1 item 2): a mensagem do CRM vai a FAILED. FAILED não vira entregue nem
 * conta como contato (a linha do tempo do CRM ignora mensagem enviada que falhou). Mensagem que já recebeu evidência de entrega não volta atrás. Consumidor idempotente.
 */
async function onDispatchFailed(event, transaction) {
  const p = event.payloadJson || {};
  if (!p.dispatchId || !(p.aggregate && p.aggregate.type === 'Message')) return;
  const message = await Message.findOne({ where: { dispatchId: p.dispatchId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message || !shouldApply(message.deliveryStatus, STATUS.FAILED)) return;
  await updateMessageStatus(message.id, STATUS.FAILED, null, transaction, { fromProvider: true });
}

let installed = false;
function installMessageFailureConsumer() {
  if (installed) return;
  installed = true;
  registerEventConsumer('integration.dispatch.failed', CONSUMER, onDispatchFailed);
}

module.exports = { installMessageFailureConsumer, onDispatchFailed, CONSUMER };
