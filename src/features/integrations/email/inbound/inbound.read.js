'use strict';

const { Op } = require('sequelize');
const { EmailInboundMessage, EmailInboundAttachment } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const E = require('./inbound.errors');
const { ATTACHMENT_STATUS: S, BLOCKED_MESSAGE, LINK_KINDS } = require('./inbound.constants');

const attView = (a) => ({
  id: a.id, position: a.position, fileName: a.fileName, mimeType: a.declaredMime, sizeBytes: Number(a.sizeBytes), status: a.status, fileId: a.fileId || null,
  ...(a.status === S.BLOCKED || a.status === S.REJECTED ? { code: a.blockCode, message: BLOCKED_MESSAGE } : {}),
});

const view = (m, atts) => ({
  id: m.id, connectionId: m.connectionId, from: m.fromAddress, to: m.toAddresses, subject: m.subject, body: m.bodyMasked, containsPii: m.containsPii, piiTypes: m.piiTypes, panRedacted: m.panRedacted,
  linkStatus: m.linkStatus, linkKind: m.linkKind, linkedEntityType: m.linkedEntityType, linkedEntityId: m.linkedEntityId, receivedAt: m.receivedAt, attachments: (atts || []).map(attView),
});

/** Lista as mensagens recebidas. Quem não tem o perfil autorizado (`canReadPii:false`) não vê as que contêm dado pessoal. Filtros: linkStatus (LINKED ou UNLINKED), limit. */
async function listInboundMessages(ctx, { canReadPii = false, linkStatus, limit = 50 } = {}, transaction) {
  const where = { companyId: ctx.companyId };
  if (linkStatus === 'LINKED' || linkStatus === 'UNLINKED') where.linkStatus = linkStatus;
  if (!canReadPii) where.containsPii = false;
  const linhas = await EmailInboundMessage.findAll({ where, order: [['received_at', 'DESC'], ['id', 'DESC']], limit: Math.max(1, Math.min(Number(limit) || 50, 200)), transaction });
  const ids = linhas.map((m) => m.id);
  const atts = ids.length ? await EmailInboundAttachment.findAll({ where: { companyId: ctx.companyId, messageId: { [Op.in]: ids } }, order: [['position', 'ASC']], transaction }) : [];
  return { items: linhas.map((m) => view(m, atts.filter((a) => a.messageId === m.id))) };
}

async function load(ctx, id, canReadPii, transaction, lock) {
  const m = await EmailInboundMessage.findOne({ where: { id, companyId: ctx.companyId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!m) throw E.notFound();
  if (m.containsPii && !canReadPii) throw E.piiRestricted();
  return m;
}

async function getInboundMessage(ctx, id, { canReadPii = false } = {}, transaction) {
  const m = await load(ctx, id, canReadPii, transaction);
  const atts = await EmailInboundAttachment.findAll({ where: { companyId: ctx.companyId, messageId: m.id }, order: [['position', 'ASC']], transaction });
  return view(m, atts);
}

/** Vínculo explícito do operador (M9-D235 3.2): mensagem não vinculada passa a LINKED/MANUAL com a entidade informada. Mensagem com dado pessoal exige o perfil autorizado. */
async function linkInboundMessage(ctx, id, { entityType, entityId, canReadPii = true }, transaction) {
  const tipo = String(entityType || '').trim().toUpperCase();
  const ref = String(entityId === undefined || entityId === null ? '' : entityId).trim();
  if (!/^[A-Z0-9_]{2,60}$/.test(tipo) || !ref || ref.length > 64) throw E.linkInvalid('Informe o tipo (letras, números e _) e o identificador (até 64 caracteres) do processo ou cliente.');
  const m = await load(ctx, id, canReadPii, transaction, true);
  if (m.linkStatus === 'LINKED') throw E.alreadyLinked();
  await m.update({ linkStatus: 'LINKED', linkKind: LINK_KINDS.MANUAL, linkedEntityType: tipo, linkedEntityId: ref, linkedBy: ctx.userId || null, linkedAt: new Date() }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.email.inbound_linked', entityType: 'EmailInboundMessage', entityId: m.id,
    beforeJson: { linkStatus: 'UNLINKED' }, afterJson: { linkStatus: 'LINKED', linkKind: 'MANUAL', entityType: tipo, entityId: ref }, reason: 'Operador vinculou a mensagem recebida ao processo ou cliente.',
  }, transaction);
  return getInboundMessage(ctx, id, { canReadPii: true }, transaction);
}

module.exports = { listInboundMessages, getInboundMessage, linkInboundMessage };
