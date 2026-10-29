'use strict';

const logger = require('../../../utils/logger');
const { recordError } = require('../errors');
const { sha256Hex } = require('../inbox/inbox.hash');
const { truncateIp } = require('./webhooks.ip');
const { countSignatureFailure, countRefusal } = require('./webhooks.metrics');
const { withTenant } = require('./webhooks.resolve');

/**
 * Rejeição por assinatura inválida (M9-D211 passo 5): erro de integração WEBHOOK, classe SECURITY, gravidade HIGH, SEM o corpo — só o hash, o tamanho,
 * o IP truncado e o motivo — mais o contador webhook_signature_failures. Transação própria e confirmada (a resposta 401 não a desfaz). Nunca lança:
 * falhar em registrar não pode mudar a resposta nem abrir uma pista para quem forja chamadas.
 */
async function recordSignatureFailure(conn, { provider, channel, rawBody, ip, reason }) {
  countSignatureFailure(provider);
  try {
    await withTenant(conn, (transaction) => recordError({ groupId: conn.groupId, companyId: conn.companyId }, {
      providerCode: provider, connectionId: conn.connectionId, source: 'WEBHOOK', errorClass: 'SECURITY', severity: 'HIGH', errorCode: 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID',
      operation: 'webhook.receive', httpStatus: 401, message: 'Webhook recusado: a assinatura não confere com o corpo recebido.',
      payload: { reason: String(reason || 'assinatura diferente').slice(0, 80), sizeBytes: rawBody.length, ipTruncated: truncateIp(ip), channelLength: String(channel).length },
      allowlist: ['reason', 'sizeBytes', 'ipTruncated', 'channelLength'], payloadHash: sha256Hex(rawBody),
    }, transaction));
  } catch (err) {
    logger.warn({ err: err.message, provider }, 'webhook.signatureFailure.record.failed');
  }
}

/** Evento assinado mas inválido que foi para a fila morta: erro VALIDATION com o conteúdo sanitizado (sem CPF, e-mail, telefone nem segredo). */
async function recordRejectedPayload(ctx, conn, { provider, reason, detail, body, inboxId, hash, security = false }, transaction) {
  await recordError(ctx, {
    providerCode: provider, connectionId: conn.connectionId, source: 'WEBHOOK', sourceRefId: inboxId, errorClass: security ? 'SECURITY' : 'VALIDATION', severity: security ? 'HIGH' : undefined,
    errorCode: security ? 'INTEGRATION_WEBHOOK_TENANT_MISMATCH' : (reason === 'EVENT_ID_MISSING' ? 'INTEGRATION_WEBHOOK_EVENT_ID_MISSING' : 'INTEGRATION_WEBHOOK_PAYLOAD_INVALID'), operation: 'webhook.receive',
    message: reason === 'EVENT_ID_MISSING' ? 'Evento sem identificador externo; enviado para a fila de erros.' : `Evento recebido e enviado para a fila de erros (${reason}): ${detail}`,
    payload: body && typeof body === 'object' ? body : undefined, payloadHash: hash,
  }, transaction);
}

/**
 * Recusa na borda antes de qualquer gravação do evento (M9-D213 6): replay (401), corpo grande demais (413) e tipo de conteúdo não aceito (415). Contador por
 * fornecedor e código, mais um erro de integração SEM o conteúdo (tamanho, hash quando o corpo foi lido, IP truncado). Nunca lança nem muda a resposta.
 */
async function recordRefusal(conn, { provider, channel, code, httpStatus, message, errorClass = 'VALIDATION', severity, rawBody, sizeBytes, ip, reason }) {
  countRefusal(provider, code);
  try {
    await withTenant(conn, (transaction) => recordError({ groupId: conn.groupId, companyId: conn.companyId }, {
      providerCode: provider, connectionId: conn.connectionId, source: 'WEBHOOK', errorClass, severity, errorCode: code, operation: 'webhook.receive', httpStatus, message,
      payload: { reason: String(reason || code).slice(0, 80), sizeBytes: sizeBytes ?? (rawBody ? rawBody.length : null), ipTruncated: truncateIp(ip), channelLength: String(channel).length },
      allowlist: ['reason', 'sizeBytes', 'ipTruncated', 'channelLength'], payloadHash: rawBody ? sha256Hex(rawBody) : undefined,
    }, transaction));
  } catch (err) {
    logger.warn({ err: err.message, provider, code }, 'webhook.refusal.record.failed');
  }
}

module.exports = { recordSignatureFailure, recordRejectedPayload, recordRefusal };
