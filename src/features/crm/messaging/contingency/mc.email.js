'use strict';

const { Message, Person, PersonContact, IntegrationDispatch, IntegrationConnection } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { canContact, resolveConsent } = require('../../../people/personConsents.service');
const { sendEmail } = require('../../../integrations/email');
const { transitionDispatch } = require('../../../integrations/dispatch/dispatch.transition');
const { resolveContingencyPolicy, findActive, assertAlternate } = require('../../../integrations/contingency');
const { QUEUED_STATUSES } = require('../../../integrations/contingency/contingency.constants');
const { readContingencyMessagingParams } = require('./mc.params');
const { isMarketingPurpose } = require('./mc.essential');
const E = require('./mc.errors');

const finalidade = (p) => String(p || 'TRANSACTIONAL').toUpperCase();

/** O e-mail principal do contato (ou o mais antigo), ou null. */
async function emailOf(personId, transaction) {
  const contatos = await PersonContact.findAll({ where: { personId, contactType: 'EMAIL' }, order: [['is_primary', 'DESC'], ['created_at', 'ASC']], limit: 1, transaction });
  return contatos[0] ? contatos[0].valueNormalized || contatos[0].value : null;
}

/** Consentimento do contato no canal alternativo (e-mail): sem OPT_OUT e, se a empresa exige (padrão), com OPT_IN explícito da finalidade. */
async function hasAlternateConsent(person, purpose, params, transaction) {
  if (!(await canContact(person, 'EMAIL', purpose, transaction))) return false;
  if (!params.alternateRequiresOptIn) return true;
  const registro = await resolveConsent(person.id, 'EMAIL', purpose, transaction);
  return Boolean(registro) && registro.status === 'OPT_IN';
}

async function loadQueued(ctx, messageId, transaction) {
  const message = await Message.findOne({ where: { id: messageId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!message || message.direction !== 'OUTBOUND' || message.channel !== 'WHATSAPP' || message.deliveryStatus !== 'QUEUED' || !message.dispatchId) throw E.notQueued();
  const dispatch = await IntegrationDispatch.findOne({ where: { id: message.dispatchId, companyId: ctx.companyId }, transaction });
  if (!dispatch || !QUEUED_STATUSES.includes(dispatch.status) || dispatch.operation !== 'sendText') throw E.notQueued();
  return { message, dispatch };
}

/**
 * Leva UMA mensagem de texto da fila do WhatsApp para o e-mail do contato (M9-D227 3.1 item 2). Exige a contingência ativa, o alternativo da política (conexão de e-mail elegível)
 * e o consentimento do contato no e-mail (409 INTEGRATION_MESSAGING_NO_CONSENT_ALTERNATE sem ele; nada é enviado). O e-mail leva o texto adaptado (abertura configurável + texto original), o
 * envio do WhatsApp é cancelado e a mensagem do CRM fica marcada "enviada por canal alternativo". Marketing nunca usa o alternativo. Mesma chave: a mesma mensagem, sem segundo e-mail.
 */
async function sendViaAlternateChannel(ctx, messageId, { auth, now = new Date() } = {}, transaction) {
  const { message, dispatch } = await loadQueued(ctx, messageId, transaction);
  if (isMarketingPurpose(message.purpose)) throw E.marketing();
  const primary = await IntegrationConnection.findOne({ where: { id: dispatch.connectionId, companyId: ctx.companyId }, transaction });
  if (!primary || !(await findActive(ctx, { connectionId: primary.id }, transaction))) throw E.notInContingency();
  const policy = await resolveContingencyPolicy(ctx, primary, transaction);
  await assertAlternate(ctx, primary, policy && policy.alternateConnectionId, 'sendEmail', now, transaction, { crossDomain: 'EMAIL' });
  const person = message.personId ? await Person.findByPk(message.personId, { transaction }) : null;
  const params = await readContingencyMessagingParams(ctx, transaction);
  const fin = finalidade(message.purpose);
  if (!person || !(await hasAlternateConsent(person, fin, params, transaction))) throw E.noConsent();
  const endereco = await emailOf(person.id, transaction);
  if (!endereco) throw E.noAddress();
  const enviado = await sendEmail(ctx, {
    auth: auth || { ...ctx, permissions: [] }, to: [endereco], subject: params.alternateEmailSubject, bodyText: `${params.alternateEmailIntro}\n\n${message.body}`, purpose: fin,
    origin: { type: 'Message', id: message.id }, idempotencyKey: `crm-message-alt:${message.id}`,
  }, transaction);
  const motivo = 'WhatsApp principal fora: a mensagem seguiu por e-mail, o canal alternativo autorizado pelo contato.';
  await transitionDispatch(ctx, dispatch.id, 'CANCELLED', {}, { motivo }, transaction);
  await message.update({ status: 'CANCELLED', deliveryStatus: 'CANCELLED', failureReason: 'Enviada por canal alternativo (e-mail).', alternateChannel: 'EMAIL', alternateRef: enviado.message.id, alternateAt: now }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'crm.message.sent_via_alternate_channel', entityType: 'Message', entityId: message.id,
    beforeJson: { deliveryStatus: 'QUEUED', dispatchId: dispatch.id }, afterJson: { alternateChannel: 'EMAIL', emailMessageId: enviado.message.id, deliveryStatus: 'CANCELLED' }, reason: motivo,
  }, transaction);
  return { messageId: message.id, alternateChannel: 'EMAIL', emailMessageId: enviado.message.id, emailDispatchId: enviado.dispatchId };
}

module.exports = { sendViaAlternateChannel, hasAlternateConsent, emailOf };
