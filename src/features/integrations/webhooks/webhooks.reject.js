'use strict';

const logger = require('../../../utils/logger');
const { recordError } = require('../errors');
const { sha256Hex } = require('../inbox/inbox.hash');
const { truncateIp } = require('./webhooks.ip');
const { countSignatureFailure } = require('./webhooks.metrics');
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
    errorCode: security ? 'INTEGRATION_WEBHOOK_TENANT_MISMATCH' : 'INTEGRATION_WEBHOOK_PAYLOAD_INVALID', operation: 'webhook.receive', message: `Evento recebido e enviado para a fila de erros (${reason}): ${detail}`,
    payload: body && typeof body === 'object' ? body : undefined, payloadHash: hash,
  }, transaction);
}

module.exports = { recordSignatureFailure, recordRejectedPayload };
