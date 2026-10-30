'use strict';

const { Message } = require('../../../../../models');
const { updateMessageStatus } = require('../../../../crm/messages.service');
const { messagingStatus: { shouldApply } } = require('../../../../integrations');
const { automatic } = require('../../../suppression');
const { audit } = require('../message/message.persist');
const { notifyDelivery } = require('./delivery.listeners');

/**
 * M9-D429 regra 6 — status de entrega do WhatsApp e do e-mail aplicado à mensagem do CRM. SENT é só "aceita pelo provedor"; DELIVERED e READ (ou
 * OPENED/CLICKED no e-mail) são a evidência de contato; FAILED, UNDELIVERED e BOUNCED gravam FAILED e NUNCA tocam o último contato nem as tarefas
 * (o CRM só conta contato com DELIVERED/READ para mensagem automática). Dois status simultâneos da mesma mensagem: a linha é travada (FOR UPDATE) e
 * vale o mais avançado (DELIVERED > SENT; FAILED não sobrescreve READ), pela regra única da M9-D229. O mesmo evento repetido não muda nada.
 * Bounce permanente, reclamação e número inválido viram supressão (M9-D418).
 */
const STATUS_MAP = Object.freeze({
  SENT: 'SENT', DELIVERED: 'DELIVERED', READ: 'READ', OPENED: 'READ', CLICKED: 'READ',
  FAILED: 'FAILED', UNDELIVERED: 'FAILED', BOUNCED: 'FAILED', BOUNCED_HARD: 'FAILED', BOUNCED_SOFT: 'FAILED', COMPLAINED: 'FAILED', INVALID_NUMBER: 'FAILED',
});

const REASON = Object.freeze({
  FAILED: 'O canal informou falha na entrega.', UNDELIVERED: 'A mensagem não foi entregue.', BOUNCED: 'O e-mail foi devolvido (endereço inexistente ou recusado).',
  BOUNCED_HARD: 'O e-mail foi devolvido (endereço inexistente ou recusado).', BOUNCED_SOFT: 'O e-mail foi devolvido temporariamente.',
  COMPLAINED: 'O destinatário marcou a mensagem como spam.', INVALID_NUMBER: 'Número de telefone inválido.',
});

/** O que a supressão faz com o evento (null = nada). Bounce leve é temporário e não suprime. */
const SUPPRESSION_OF = Object.freeze({ BOUNCED: 'handlePermanentBounce', BOUNCED_HARD: 'handlePermanentBounce', COMPLAINED: 'handleSpamComplaint', INVALID_NUMBER: 'handleInvalidNumber' });

async function applyDeliveryStatus({ tenant, channel, providerRef, status }, transaction) {
  const raw = String(status || '').toUpperCase();
  const next = STATUS_MAP[raw];
  if (!next || !providerRef) return { applied: false, reason: next ? 'NO_PROVIDER_REF' : 'STATUS_UNMAPPED' };
  const message = await Message.findOne({
    where: { companyId: tenant.companyId, externalMessageId: String(providerRef), direction: 'OUTBOUND', channel }, transaction, lock: transaction.LOCK.UPDATE,
  });
  if (!message) return { applied: false, reason: 'UNKNOWN_MESSAGE' };
  const current = message.deliveryStatus || message.status;
  const apply = shouldApply(current, next);
  if (apply) {
    await updateMessageStatus(message.id, next, null, transaction, { fromProvider: true });
    if (next === 'FAILED') await Message.update({ failureReason: REASON[raw] || REASON.FAILED }, { where: { id: message.id }, transaction });
    await audit(tenant, 'marketing.message.delivery_status', 'Message', message.id, { from: current, to: next, providerStatus: raw },
      `Status de entrega ${current} -> ${next} por evidência do canal (${raw}).`, transaction);
    await notifyDelivery({ tenant, messageId: message.id, status: next }, transaction); // M9-D424: o pedido de avaliação acompanha a entrega da sua mensagem
  }
  const suppressor = SUPPRESSION_OF[raw];
  let suppressed = false;
  if (suppressor && message.personId && (apply || current === 'FAILED')) {
    await automatic[suppressor]({ personId: message.personId, channel }, tenant, transaction);
    suppressed = true;
  }
  return { applied: apply, from: current, to: apply ? next : current, suppressed, messageId: message.id, reason: apply ? null : 'NOT_NEWER' };
}

module.exports = { applyDeliveryStatus, STATUS_MAP };
