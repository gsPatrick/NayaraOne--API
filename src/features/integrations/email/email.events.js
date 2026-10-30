'use strict';

const { EmailMessage, EmailMessageEvent, IntegrationDispatch } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { redactFreeText } = require('../../../shared/redaction');
const { recordError } = require('../errors');
const { registerDomainHandler } = require('../webhooks/worker/worker.handlers');
const { EVENT_STATUSES } = require('./email.constants');

/** Erro de integração do evento recusado, SEM o conteúdo (só ids e códigos). */
const refuse = (ctx, row, { code, message, severity }, transaction) => recordError(ctx, {
  providerCode: row.providerCode, connectionId: row.connectionId || null, source: 'WEBHOOK', sourceRefId: row.id, operation: 'webhook.email', errorClass: 'VALIDATION', severity, errorCode: code, message,
  payload: { inboxId: row.id, externalEventId: row.externalEventId }, allowlist: ['inboxId', 'externalEventId'],
}, transaction);

/** A mensagem do evento: pelo par (connection, identificador do provedor); senão pelo envio que o reconciliador resolveu (identificador ainda não aprendido). */
async function findMessage(ctx, row, externalMessageId, transaction) {
  const base = { companyId: ctx.companyId };
  const achada = await EmailMessage.findOne({ where: { ...base, connectionId: row.connectionId, externalMessageId }, transaction, lock: transaction.LOCK.UPDATE });
  if (achada) return achada;
  const envio = await IntegrationDispatch.findOne({ where: { ...base, connectionId: row.connectionId, operation: 'sendEmail', externalResourceId: externalMessageId }, transaction });
  const pendente = envio && await EmailMessage.findOne({ where: { ...base, dispatchId: envio.id, externalMessageId: null }, transaction, lock: transaction.LOCK.UPDATE });
  if (pendente) await pendente.update({ externalMessageId }, { transaction });
  return pendente || null;
}

/** Motivo informado pelo provedor, sem dado pessoal (o texto do provedor pode citar o endereço) e com tamanho limitado. */
const reasonOf = (priv) => (priv && priv.reason ? String(redactFreeText(String(priv.reason))).slice(0, 300) : null);

/**
 * Tratador do domínio EMAIL do worker da caixa de entrada (M9-D212 + M9-D234 3.2 item 2): aplica o evento normalizado do provedor à mensagem. DELIVERED só chega por aqui (nenhum
 * outro caminho declara a entrega); BOUNCED_SOFT, BOUNCED_HARD, COMPLAINED e FAILED são registrados como o provedor informou. Cada evento aplicado entra no histórico da mensagem
 * e na auditoria. Evento de mensagem desconhecida fica recusado com erro de integração.
 */
async function applyEmailEvent(ctx, row, ev, transaction) {
  const kind = ev.data && ev.data.kind;
  if (!EVENT_STATUSES.includes(kind)) return { applied: false };
  const message = await findMessage(ctx, row, ev.data.externalMessageId, transaction);
  if (!message) {
    await refuse(ctx, row, { code: 'INTEGRATION_EMAIL_MESSAGE_UNKNOWN', message: 'Evento de e-mail de uma mensagem que o sistema não conhece.', severity: 'MEDIUM' }, transaction);
    return { applied: false };
  }
  const priv = ev.private || {};
  const quando = priv.occurredAt && !Number.isNaN(Date.parse(priv.occurredAt)) ? new Date(priv.occurredAt) : new Date();
  const motivo = reasonOf(priv);
  const bounceType = kind === 'BOUNCED_HARD' ? 'hard' : (kind === 'BOUNCED_SOFT' ? 'soft' : null);
  const anterior = message.status;
  const patch = { status: kind, lastEventAt: quando };
  if (kind === 'DELIVERED') patch.deliveredAt = quando;
  if (bounceType) patch.bounceType = bounceType;
  if (kind !== 'DELIVERED') patch.failureReason = motivo || { BOUNCED_SOFT: 'Devolvido temporariamente.', BOUNCED_HARD: 'Endereço inexistente ou recusado.', COMPLAINED: 'O destinatário marcou como spam.', FAILED: 'Falha na entrega.' }[kind];
  await message.update(patch, { transaction });
  await EmailMessageEvent.create({ groupId: message.groupId, companyId: message.companyId, messageId: message.id, inboxId: row.id, kind, previousStatus: anterior, bounceType, detail: motivo, occurredAt: quando }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'integration.email.status_changed', entityType: 'EmailMessage', entityId: message.id,
    beforeJson: { status: anterior }, afterJson: { status: kind, bounceType }, reason: `Evento do provedor aplicado à mensagem: ${anterior} -> ${kind}.`,
  }, transaction);
  return { applied: true };
}

let installed = false;
function installEmailEvents() {
  if (installed) return;
  installed = true;
  registerDomainHandler('EMAIL', applyEmailEvent);
}

module.exports = { applyEmailEvent, installEmailEvents, findMessage };
