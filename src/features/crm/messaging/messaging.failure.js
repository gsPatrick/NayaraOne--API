'use strict';

const { Message } = require('../../../models');
const { registerDomainReaction } = require('../../integrations/domain');
const { messagingStatus: { shouldApply, STATUS } } = require('../../integrations');
const { updateMessageStatus } = require('../messages.service');

const CONSUMER = 'crm.messaging.dispatch_failed';

/**
 * Envio que terminou em falha (`integration.dispatch.failed`, M9-D229 3.2 item 1 e M9-D220 3.1 item 2): a mensagem do CRM vai a FAILED. FAILED não vira entregue nem
 * conta como contato (a linha do tempo do CRM ignora mensagem enviada que falhou). Mensagem que já recebeu evidência de entrega não volta atrás. A reação é idempotente
 * por evento e auditada (reação padrão do domínio, M9-D220); trava a mensagem e relê o estado antes de decidir.
 */
async function onDispatchFailed(_ctx, event, transaction) {
  const p = event.payloadJson || {};
  if (!p.dispatchId || !(p.aggregate && p.aggregate.type === 'Message')) return null;
  const message = await Message.findOne({ where: { dispatchId: p.dispatchId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message || !shouldApply(message.deliveryStatus, STATUS.FAILED)) return null;
  const antes = message.deliveryStatus;
  await updateMessageStatus(message.id, STATUS.FAILED, null, transaction, { fromProvider: true });
  return { entity: { type: 'Message', id: message.id }, before: { deliveryStatus: antes }, after: { deliveryStatus: STATUS.FAILED }, reason: `Envio ${p.dispatchId} falhou no fornecedor: a mensagem vai a FAILED.` };
}

let installed = false;
function installMessageFailureConsumer() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: CONSUMER, handler: onDispatchFailed });
}

module.exports = { installMessageFailureConsumer, onDispatchFailed, CONSUMER };
