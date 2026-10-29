'use strict';

const logger = require('../../../utils/logger');
const { checkWebhookRate, enforceCompanyLimit } = require('./webhooks.rateLimit');
const { resolveChannel, noteUnknownChannel, withTenant } = require('./webhooks.resolve');
const { readWebhookParams } = require('./webhooks.params');
const { verifierFor } = require('./verifiers/registry');
const { acceptedWebhookSecrets } = require('./webhooks.secret');
const { parseEvent, foreignTenant } = require('./webhooks.payload');
const { persistAccepted, persistRejected } = require('./webhooks.persist');
const { recordSignatureFailure } = require('./webhooks.reject');
const { unknownChannel, noVerifier, signatureInvalid, tooLarge } = require('./webhooks.errors');

/**
 * POST /v1/webhooks/:provider/:channel (e o alias da raiz) — M9-D211 3.2. A ordem é a do livro e qualquer desvio é bug:
 * 2 limite por IP e fornecedor, 3 connection do canal, 4 verificador, 5 assinatura sobre o corpo bruto em tempo constante, 6 só então ler o JSON, 7 persistir e responder.
 */
function verifyAll(verifier, secrets, rawBody, headers) {
  // Confere com todas as versões aceitas (corrente e graça) sem parar na primeira que casa.
  const resultados = secrets.map((secret) => verifier.verify({ rawBody, headers, secret, now: new Date() }));
  const bom = resultados.find((r) => r.ok);
  return bom || resultados[0] || { ok: false, reason: 'segredo ausente' };
}

async function receiveWebhook(req, res) {
  const provider = String(req.params.provider || '').toLowerCase().slice(0, 48);
  const { channel } = req.params;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const rate = await checkWebhookRate(req, provider, res);
  const conn = await resolveChannel(provider, channel);
  if (!conn) {
    await noteUnknownChannel(provider);
    throw unknownChannel();
  }

  const prep = await withTenant(conn, async (transaction) => {
    const params = await readWebhookParams({ groupId: conn.groupId, companyId: conn.companyId }, transaction);
    if (req.webhookViaRootAlias && !params.aliasRootEnabled) return { params, off: true };
    const verifier = verifierFor(provider);
    if (!verifier) return { params, noVerifier: true };
    return { params, verifier, ...(await acceptedWebhookSecrets(conn, transaction)) };
  });
  if (prep.off) {
    await noteUnknownChannel(provider);
    throw unknownChannel();
  }
  enforceCompanyLimit(rate, prep.params.rateLimitPerMinute, res);
  if (rawBody.length > prep.params.maxBodyBytes) throw tooLarge();
  if (prep.noVerifier) {
    logger.warn({ provider }, 'Webhook recusado: o fornecedor não tem verificador de assinatura.');
    throw noVerifier();
  }

  const verified = verifyAll(prep.verifier, prep.secrets, rawBody, req.headers);
  if (!verified.ok) {
    await recordSignatureFailure(conn, { provider, channel, rawBody, ip: req.ip, reason: prep.reason || verified.reason });
    throw signatureInvalid();
  }

  const ctx = { groupId: conn.groupId, companyId: conn.companyId, userId: null };
  const dados = { provider, channel, rawBody, headers: req.headers };
  const result = await withTenant(conn, async (transaction) => {
    const parsed = parseEvent(rawBody, req.headers, verified);
    if (parsed.ok && foreignTenant(parsed.body, conn)) {
      return persistRejected(ctx, conn, { ...dados, body: parsed.body, eventType: parsed.eventType, reason: 'SCHEMA_INVALID', detail: 'O evento cita outra empresa ou grupo que não os do canal.', security: true }, transaction);
    }
    if (!parsed.ok) return persistRejected(ctx, conn, { ...dados, body: parsed.body, reason: parsed.reason, detail: parsed.detail }, transaction);
    return persistAccepted(ctx, conn, { ...dados, body: parsed.body, eventId: parsed.eventId, eventType: parsed.eventType }, transaction);
  });
  return res.status(200).json({ status: result.status });
}

module.exports = { receiveWebhook, verifyAll };
