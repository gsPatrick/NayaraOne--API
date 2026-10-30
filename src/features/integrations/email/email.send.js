'use strict';

const crypto = require('node:crypto');
const { EmailMessage } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const dispatchService = require('../dispatch/enqueue/dispatch.service');
const { readEmailParams } = require('./email.params');
const { normalizeRecipients } = require('./email.recipients');
const { validateAttachments } = require('./email.attachments');
const { ensureEmailConnection } = require('./email.connection');
const E = require('./email.errors');

const text = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

/** Conteúdo exigido: assunto e texto. O HTML é opcional e acompanha o texto. */
function readContent({ subject, bodyText, bodyHtml }) {
  const assunto = text(subject, 300);
  const corpo = String(bodyText === undefined || bodyText === null ? '' : bodyText).trim();
  if (!assunto || !corpo) throw E.contentRequired();
  const html = bodyHtml === undefined || bodyHtml === null || String(bodyHtml).trim() === '' ? null : String(bodyHtml);
  return { assunto, corpo, html };
}

/**
 * sendEmail — a ÚNICA porta de saída de e-mail dos módulos (M9-D234 3.1). Valida conteúdo, destinatários e anexos (autorizados, classificados, limpos, dentro do tamanho e
 * da allowlist), grava a mensagem em QUEUED e pede o envio ao Dispatch Service (conteúdo minimizado, finalidade e hash em integration.dispatches); quem chama o provedor é o worker
 * de envios, que devolve o identificador da mensagem (status SENT). Entregue, bounce e reclamação só chegam pelo evento do provedor. Mesma chave de idempotência = mesma mensagem.
 * `args`: auth (usuário que envia, com permissões, para autorizar os anexos), to, cc, bcc, subject, bodyText, bodyHtml, attachmentFileIds, replyTo, idempotencyKey, purpose, origin { type, id }.
 */
async function sendEmail(ctx, args, transaction) {
  const a = args || {};
  const params = await readEmailParams(ctx, transaction);
  const { assunto, corpo, html } = readContent(a);
  const destinos = normalizeRecipients({ to: a.to, cc: a.cc, bcc: a.bcc }, params.maxRecipients);
  const replyTo = a.replyTo ? normalizeRecipients({ to: a.replyTo }, 1).to[0] : null;
  const anexos = await validateAttachments({ auth: a.auth || { ...ctx, permissions: [] }, fileIds: a.attachmentFileIds, params, transaction });
  const connection = await ensureEmailConnection(ctx, transaction);
  const id = crypto.randomUUID();
  const chave = text(a.idempotencyKey, 160) || `email:${id}`;
  const { dispatch, created } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation: 'sendEmail', aggregateType: 'EmailMessage', aggregateId: id, idempotencyKey: chave, userId: ctx.userId || null, transaction,
    payload: {
      to: destinos.to, cc: destinos.cc, bcc: destinos.bcc, ...(replyTo ? { replyTo } : {}), subject: assunto, body: corpo, ...(html ? { bodyHtml: html } : {}),
      attachments: anexos.map((x) => ({ fileId: x.fileId, fileName: x.fileName, mimeType: x.mimeType, sizeBytes: x.sizeBytes, sha256: x.sha256, classification: x.classification })),
    },
  });
  if (!created) {
    const existente = await EmailMessage.findOne({ where: { companyId: ctx.companyId, dispatchId: dispatch.id }, transaction });
    if (existente) return { message: existente, dispatchId: dispatch.id, replay: true };
  }
  const message = await EmailMessage.create({
    id, groupId: ctx.groupId, companyId: ctx.companyId, connectionId: connection.id, providerCode: connection.providerCode, dispatchId: dispatch.id, idempotencyKey: chave,
    purpose: a.purpose ? text(a.purpose, 60) : null, originType: a.origin && a.origin.type ? text(a.origin.type, 60) : null, originId: a.origin && a.origin.id ? text(a.origin.id, 64) : null,
    toAddresses: destinos.to, ccAddresses: destinos.cc, bccAddresses: destinos.bcc, replyTo, subject: assunto, attachments: anexos, attachmentBytes: anexos.reduce((s, x) => s + x.sizeBytes, 0),
    status: 'QUEUED', requestedBy: ctx.userId || null,
  }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.email.queued', entityType: 'EmailMessage', entityId: message.id,
    afterJson: { dispatchId: dispatch.id, destinatarios: destinos.to.length + destinos.cc.length + destinos.bcc.length, anexos: anexos.map((x) => x.fileId), finalidade: message.purpose }, reason: 'E-mail enfileirado para envio pelo provedor.',
  }, transaction);
  return { message, dispatchId: dispatch.id, replay: false };
}

module.exports = { sendEmail };
