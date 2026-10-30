'use strict';

const { sequelize, EmailInboundMessage } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../../../engines/events/outbox');
const { recordError } = require('../../errors');
const { readInboundParams } = require('./inbound.params');
const { analyzePii } = require('./inbound.pii');
const { resolveLink } = require('./inbound.link');
const { receiveAttachments } = require('./inbound.attachments');
const { PAN_ERROR, DUPLICATE_CODE } = require('./inbound.constants');

const enderecos = (v) => [].concat(v || []).map((x) => String(x).trim().toLowerCase().slice(0, 254)).filter(Boolean).slice(0, 50);

/** Alerta de cartão no corpo (sem o conteúdo: só ids). */
const alertPan = (ctx, connection, inboxId, transaction) => recordError(ctx, {
  providerCode: connection.providerCode, connectionId: connection.id, source: 'WEBHOOK', sourceRefId: inboxId || null, operation: 'webhook.email.inbound', errorClass: 'VALIDATION', severity: 'HIGH', errorCode: PAN_ERROR,
  message: 'Um e-mail recebido trazia número de cartão de crédito: o corpo foi removido e nada foi guardado.', payload: inboxId ? { inboxId } : {}, allowlist: ['inboxId'],
}, transaction);

/**
 * ingestInboundEmail — o pipeline do e-mail recebido (M9-D235 3.1). `message`: { externalMessageId, from, to, subject, text, inReplyTo, references, attachments[{ fileName, contentType, contentBase64 }] }.
 *  1. idempotência pelo identificador do provedor (repetição: `{ duplicate: true }`, nada novo);
 *  2. dado pessoal: CPF, CNPJ, cartão e conta mascarados no assunto e no corpo ANTES de gravar (o original nunca é guardado); cartão completo redige o corpo e abre alerta;
 *  3. vínculo por resposta ou referência no assunto; sem vínculo a mensagem fica não vinculada e NUNCA cria processo;
 *  4. anexos pela quarentena e antivírus (inbound.attachments).
 * Devolve { message, attachments, duplicate }.
 */
async function ingestInboundEmail(ctx, { connection, inboxId = null, message }, transaction) {
  const params = await readInboundParams(ctx, transaction);
  const externalId = String(message.externalMessageId || '').slice(0, 160);
  const ja = await EmailInboundMessage.findOne({ where: { connectionId: connection.id, externalMessageId: externalId, companyId: ctx.companyId }, transaction });
  if (ja) return { message: ja, attachments: [], duplicate: true, code: DUPLICATE_CODE };
  const corpo = analyzePii(String(message.text || '').slice(0, params.bodyMaxChars));
  const assunto = analyzePii(String(message.subject || '').slice(0, 300));
  const tipos = [...new Set([...corpo.types, ...assunto.types])];
  const pan = corpo.pan || assunto.pan;
  const vinculo = await resolveLink(ctx, { connectionId: connection.id, inReplyTo: message.inReplyTo || message.references, subject: String(message.subject || ''), prefixes: params.referencePrefixes }, transaction);
  let criada;
  try {
    criada = await sequelize.transaction({ transaction }, (sp) => EmailInboundMessage.create({
      groupId: ctx.groupId, companyId: ctx.companyId, connectionId: connection.id, providerCode: connection.providerCode, inboxId, externalMessageId: externalId,
      fromAddress: enderecos(message.from)[0] || null, toAddresses: enderecos(message.to), subject: assunto.text.slice(0, 300), bodyMasked: corpo.text, containsPii: tipos.length > 0, piiTypes: tipos, panRedacted: pan,
      linkStatus: vinculo ? 'LINKED' : 'UNLINKED', linkKind: vinculo ? vinculo.kind : null, linkedEntityType: vinculo ? vinculo.entityType : null, linkedEntityId: vinculo ? vinculo.entityId : null,
      linkedEmailMessageId: vinculo ? vinculo.emailMessageId : null, linkedAt: vinculo ? new Date() : null, receivedAt: new Date(),
    }, { transaction: sp }));
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') return { message: await EmailInboundMessage.findOne({ where: { connectionId: connection.id, externalMessageId: externalId, companyId: ctx.companyId }, transaction }), attachments: [], duplicate: true, code: DUPLICATE_CODE };
    throw err;
  }
  if (pan) await alertPan(ctx, connection, inboxId, transaction);
  const itens = Array.isArray(message.attachments) ? message.attachments : [];
  const anexos = await receiveAttachments(ctx, { message: criada, connectionId: connection.id, items: itens, params }, transaction);
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'integration.email.inbound_received', entityType: 'EmailInboundMessage', entityId: criada.id,
    afterJson: { linkStatus: criada.linkStatus, linkKind: criada.linkKind, piiTypes: tipos, panRedacted: pan, attachments: anexos.map((a) => a.status) }, reason: 'E-mail recebido passou pelo pipeline de malware e dado pessoal.',
  }, transaction);
  await publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'EmailInboundMessage', aggregateId: criada.id, eventType: 'integration.email.inbound.received',
    payload: { messageId: criada.id, linked: criada.linkStatus === 'LINKED', containsPii: criada.containsPii, attachments: anexos.length }, idempotencyKey: `integration.email.inbound.received:${criada.id}`,
  }, transaction);
  return { message: criada, attachments: anexos, duplicate: false };
}

module.exports = { ingestInboundEmail };
