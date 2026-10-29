'use strict';

const { receiveEvent } = require('../inbox');
const { sha256Hex } = require('../inbox/inbox.hash');
const { rejectedEventId } = require('./webhooks.payload');
const { recordRejectedPayload } = require('./webhooks.reject');

/** Grava o evento autenticado e lido na caixa de entrada (M9-D211 passo 7). Duplicado (mesmo fornecedor e id) não grava de novo. */
async function persistAccepted(ctx, conn, d, transaction) {
  const r = await receiveEvent(ctx, {
    providerCode: d.provider, externalEventId: d.eventId, rawBody: d.rawBody, body: d.body, headers: d.headers, eventType: d.eventType,
    channel: d.channel, connectionId: conn.connectionId, maxStoredBytes: d.maxStoredBytes,
  }, transaction);
  return { status: r.status === 'duplicate' ? 'duplicate' : 'accepted', inboxId: r.id, eventId: d.eventId };
}

/**
 * Evento com assinatura válida mas conteúdo inválido (decisão C6): nunca vira 4xx (o fornecedor reenviaria em laço). A linha nasce DEAD_LETTER com o
 * motivo, sem o corpo guardado, e o erro de integração leva o conteúdo sanitizado. A resposta é 200 {"status":"rejected_to_dlq"}.
 */
async function persistRejected(ctx, conn, d, transaction) {
  const hash = sha256Hex(d.rawBody);
  const r = await receiveEvent(ctx, {
    providerCode: d.provider, externalEventId: rejectedEventId(d.provider, hash), rawBody: d.rawBody, headers: d.headers, eventType: d.eventType || null,
    channel: d.channel, connectionId: conn.connectionId, deadLetterReason: d.reason,
  }, transaction);
  await recordRejectedPayload(ctx, conn, { provider: d.provider, reason: d.reason, detail: d.detail, body: d.body, inboxId: r.id, hash, security: Boolean(d.security) }, transaction);
  return { status: 'rejected_to_dlq', inboxId: r.id };
}

module.exports = { persistAccepted, persistRejected };
