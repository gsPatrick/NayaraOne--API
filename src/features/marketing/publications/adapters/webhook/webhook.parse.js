'use strict';

const { hmacWithTimestamp } = require('../../../../integrations/webhooks/verifiers/hmac');
const { webhookSignatureInvalid, webhookPayloadInvalid } = require('../channel.errors');

/** Texto não vazio de até 160 caracteres (ou null). */
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null));

/**
 * Confere a assinatura do webhook do canal ANTES de ler o JSON (HMAC-SHA256 com horário assinado, cabeçalho x-signature, o mesmo verificador dos sandboxes do
 * bloco B) com todos os segredos aceitos (versão corrente e a da janela de graça). Sem segredo, cabeçalho ou assinatura que confira: 401
 * MKT_WEBHOOK_SIGNATURE_INVALID. Só então lê o corpo: JSON inválido ou raiz que não é objeto é 422 MKT_WEBHOOK_PAYLOAD_INVALID.
 * Devolve o evento normalizado { channel, eventId, eventType, providerRef, status, timestamp, data }.
 */
function verifyAndParseWebhook({ channel, headers, rawBody, secrets }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const verifier = hmacWithTimestamp();
  const verdicts = (secrets || []).filter(Boolean).map((secret) => verifier.verify({ rawBody: body, headers: headers || {}, secret, now: new Date() }));
  const good = verdicts.find((v) => v.ok);
  if (!good) throw webhookSignatureInvalid();
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { throw webhookPayloadInvalid({ motivo: 'JSON inválido' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw webhookPayloadInvalid({ motivo: 'a raiz precisa ser um objeto' });
  const status = text(parsed.status);
  return {
    channel,
    eventId: text(parsed.id ?? parsed.event_id ?? parsed.eventId),
    eventType: text(parsed.type ?? parsed.event_type ?? parsed.eventType),
    providerRef: text(parsed.resourceId ?? parsed.resource_id ?? parsed.providerRef),
    status: status ? status.toUpperCase() : null,
    timestamp: good.timestamp ?? null,
    data: parsed,
    rawBody: body,
  };
}

module.exports = { verifyAndParseWebhook };
