'use strict';

const { resolveChannel, withTenant } = require('../../../../integrations/webhooks/webhooks.resolve');
const { acceptedWebhookSecrets } = require('../../../../integrations/webhooks/webhooks.secret');
const { readWebhookParams } = require('../../../../integrations/webhooks/webhooks.params');
const { recordSignatureFailure } = require('../../../../integrations/webhooks/webhooks.reject');
const { persistAccepted } = require('../../../../integrations/webhooks/webhooks.persist');
const { assertFreshTimestamp } = require('../../../../integrations/webhooks/intake/intake.replay');
const { normalizeChannel, channelNotFound, webhookPayloadInvalid } = require('../channel.errors');
const { verifyAndParseWebhook } = require('./webhook.parse');
const { runWebhookEventHooks } = require('./webhook.hooks');

/**
 * Recebimento do webhook de um canal do Marketing (M9-D430 5: POST /marketing/webhooks/:channel). Rota pública: a assinatura é a autorização. A empresa vem
 * SEMPRE da connection do canal (token opaco do bloco B, `?provider=<código>&token=<canal>`), nunca do corpo. Ordem: canal do Marketing e connection
 * (404 sem vazar nada), segredos do cofre, assinatura sobre o corpo bruto ANTES de ler o JSON (401 MKT_WEBHOOK_SIGNATURE_INVALID, registrada como erro de
 * segurança do bloco B), janela de tempo contra replay (parâmetro da empresa), evento normalizado e gravado na caixa de entrada do framework. Duplicado não grava de novo.
 */
async function receiveChannelWebhook({ channel: channelName, provider, token, headers, rawBody, ip }) {
  let channel;
  try { channel = normalizeChannel(channelName); } catch { throw channelNotFound(); }
  const providerCode = String(provider || '').toLowerCase().slice(0, 48);
  const conn = await resolveChannel(providerCode, String(token || ''));
  if (!conn) throw channelNotFound();
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) throw webhookPayloadInvalid({ motivo: 'corpo ausente' });

  const { secrets } = await withTenant(conn, (transaction) => acceptedWebhookSecrets(conn, transaction));
  let event;
  try {
    event = verifyAndParseWebhook({ channel, headers, rawBody, secrets });
  } catch (err) {
    if (err.code === 'MKT_WEBHOOK_SIGNATURE_INVALID') await recordSignatureFailure(conn, { provider: providerCode, channel: token, rawBody, ip, reason: secrets.length ? 'assinatura diferente' : 'segredo do webhook não configurado' });
    throw err;
  }
  return withTenant(conn, (transaction) => ingestChannelEvent({ conn, provider: providerCode, token, channel, event, headers, rawBody }, transaction));
}

/**
 * Segunda metade do recebimento, depois da assinatura conferida (M9-D442 a reaproveita no failure drill, na transação do ensaio): janela de tempo contra replay, evento gravado na
 * caixa de entrada do framework (duplicado não grava de novo) e, só para evento NOVO, os ganchos do canal (status de entrega, M9-D429). `runHooks` é injetável só para o ensaio contar.
 */
async function ingestChannelEvent({ conn, provider, token, channel, event, headers, rawBody }, transaction, { runHooks = runWebhookEventHooks } = {}) {
  const params = await readWebhookParams({ groupId: conn.groupId, companyId: conn.companyId }, transaction);
  assertFreshTimestamp(event.timestamp, params.timestampToleranceS);
  if (!event.eventId || event.eventId.length > 160) throw webhookPayloadInvalid({ motivo: 'o evento não traz identificador' });
  const ctx = { groupId: conn.groupId, companyId: conn.companyId, userId: null };
  const saved = await persistAccepted(ctx, conn, {
    provider, channel: String(token), rawBody, body: event.data, headers, eventId: event.eventId, eventType: event.eventType, maxStoredBytes: params.maxBodyBytes,
  }, transaction);
  if (saved.status === 'accepted') await runHooks({ tenant: { groupId: conn.groupId, companyId: conn.companyId }, channel, event }, transaction); // M9-D429: status de entrega
  return { status: saved.status, eventId: saved.eventId };
}

module.exports = { receiveChannelWebhook, ingestChannelEvent };
