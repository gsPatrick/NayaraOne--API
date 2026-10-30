'use strict';

const { Message, IntegrationConnection } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { registerDomainHandler } = require('../../integrations/webhooks/worker/worker.handlers');
const { messagingStatus: { shouldApply }, MESSAGING_EVENT_KINDS: KINDS } = require('../../integrations');
const { createMessage, updateMessageStatus } = require('../messages.service');
const { resolveSender } = require('./messaging.sender');
const { assertE164 } = require('./messaging.phone');
const { readMessagingParams } = require('./messaging.params');
const { readWhatsappParams } = require('./whatsapp.params');
const { ensureConversation, markInbound } = require('./whatsapp.conversation');
const { applyKeywordOptOut } = require('./whatsapp.optout');
const { receiveInboundMedia } = require('./whatsapp.inboundMedia');
const { PADRAO_ENTREGA } = require('./whatsapp.reasons');

const audit = (ctx, action, message, reason, extra, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action, entityType: 'Message', entityId: message.id, afterJson: extra || null, reason,
}, transaction);

/**
 * Status de uma mensagem enviada (M9-D229 3.1 e 3.2 item 1): a evidência é o evento assinado do fornecedor. Só avança (READ antes de DELIVERED permanece READ), FAILED é terminal e
 * a mensagem já entregue não volta a falhar. Mensagem que o sistema ainda não conhece pelo id do fornecedor (o evento chegou antes de o envio ser ligado) volta para nova tentativa.
 */
async function onStatus(ctx, row, ev, transaction) {
  const message = await Message.findOne({ where: { companyId: ctx.companyId, connectionId: row.connectionId, externalMessageId: ev.data.externalMessageId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message) {
    // Evento que chegou antes de o envio ser ligado ao id do fornecedor: há mensagem nossa na fila desta connection, então volta para nova tentativa. Sem nenhuma, a mensagem não é nossa e o domínio nada muda.
    const naFila = await Message.count({ where: { companyId: ctx.companyId, connectionId: row.connectionId, direction: 'OUTBOUND', deliveryStatus: 'QUEUED', externalMessageId: null }, transaction });
    if (naFila > 0) throw new Error('A mensagem do evento ainda não está ligada a um envio; o evento será tentado de novo.');
    return undefined;
  }
  if (!shouldApply(message.deliveryStatus, ev.internalStatus)) return { applied: false };
  const antes = message.deliveryStatus;
  await updateMessageStatus(message.id, ev.internalStatus, null, transaction, { fromProvider: true });
  if (ev.internalStatus === 'FAILED') await Message.update({ failureReason: PADRAO_ENTREGA }, { where: { id: message.id }, transaction }); // M9-D230 3.4: falha sempre com o motivo em português
  await audit(ctx, 'crm.message.delivery_status', message, `Status de entrega ${antes} -> ${ev.internalStatus} por evidência do fornecedor.`, { antes, depois: ev.internalStatus }, transaction);
  return { applied: true };
}

/**
 * Mensagem recebida (M9-D229 3.2 item 3): vira interação INBOUND na pessoa (remetente desconhecido = lead provisório), deduplicada por (connection, id do fornecedor); a
 * repetição devolve `INTEGRATION_MESSAGING_DUPLICATE_IGNORED` (200, ignorada). O texto fica só na mensagem do CRM: nunca em log nem no outbox.
 */
async function onInbound(ctx, row, ev, transaction) {
  const priv = ev.private || {};
  const params = await readMessagingParams(ctx, transaction);
  const ja = await Message.findOne({ where: { companyId: ctx.companyId, connectionId: row.connectionId, externalMessageId: ev.data.externalMessageId }, transaction });
  if (ja) {
    await audit(ctx, 'crm.message.duplicate_ignored', ja, 'Mensagem já recebida; ignorada.', { code: 'INTEGRATION_MESSAGING_DUPLICATE_IGNORED' }, transaction);
    return { applied: false, code: 'INTEGRATION_MESSAGING_DUPLICATE_IGNORED' };
  }
  const from = assertE164(priv.from, params.countryCode);
  const quem = await resolveSender(ctx, { from, name: priv.name }, transaction);
  const connection = await IntegrationConnection.findByPk(row.connectionId, { transaction });
  const conversa = await ensureConversation(ctx, quem.personId, { connection, externalConversationId: from }, transaction);
  await markInbound(conversa, new Date(), transaction); // o cliente escreveu: a janela de atendimento reabre
  // Mídia recebida (M9-D230 3.3): buscada só pelo guarda SSRF e guardada em quarentena; sem como baixar com segurança, a interação mostra "mídia bloqueada".
  const midia = priv.mediaRef ? await receiveInboundMedia(ctx, { url: priv.mediaRef, connection }, transaction) : null;
  const message = await createMessage({
    groupId: ctx.groupId, companyId: ctx.companyId, personId: quem.personId, opportunityId: quem.opportunityId, channel: 'WHATSAPP', direction: 'INBOUND', authorType: 'CLIENT',
    body: priv.text || (priv.mediaRef ? '[mídia recebida]' : null), externalMessageId: ev.data.externalMessageId, connectionId: row.connectionId, conversationId: conversa.id,
    mediaQuarantineId: midia && midia.quarantineId ? midia.quarantineId : null,
  }, null, transaction);
  if (midia && !midia.quarantineId) await Message.update({ mediaState: 'BLOCKED' }, { where: { id: message.id }, transaction });
  await audit(ctx, 'crm.message.inbound', message, `Mensagem recebida registrada${quem.provisional ? ' (lead provisório criado)' : ''}.`, { provisional: quem.provisional, media: midia ? (midia.quarantineId ? 'QUARANTINED' : midia.code) : null }, transaction);
  await applyKeywordOptOut(ctx, { personId: quem.personId, text: priv.text, message, params: await readWhatsappParams(ctx, transaction) }, transaction);
  return { applied: true };
}

/** Tratador do domínio MESSAGING do worker da caixa de entrada (M9-D212 + M9-D229). */
async function applyMessagingEvent(ctx, row, ev, transaction) {
  if (ev.data && ev.data.kind === KINDS.STATUS) return onStatus(ctx, row, ev, transaction);
  if (ev.data && ev.data.kind === KINDS.INBOUND) return onInbound(ctx, row, ev, transaction);
  return { applied: false };
}

let installed = false;
function installMessagingEvents() {
  if (installed) return;
  installed = true;
  registerDomainHandler('MESSAGING', applyMessagingEvent);
}

module.exports = { applyMessagingEvent, installMessagingEvents };
