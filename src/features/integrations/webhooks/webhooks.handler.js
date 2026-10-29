'use strict';

const logger = require('../../../utils/logger');
const { withTenant } = require('./webhooks.resolve');
const { verifierFor } = require('./verifiers/registry');
const adapterRegistry = require('../registry/adapterRegistry');
const { acceptedWebhookSecrets } = require('./webhooks.secret');
const { parseEvent, foreignTenant } = require('./webhooks.payload');
const { persistAccepted, persistRejected } = require('./webhooks.persist');
const { recordSignatureFailure, recordRefusal } = require('./webhooks.reject');
const { noVerifier, signatureInvalid } = require('./webhooks.errors');
const { assertMediaType } = require('./intake/intake.mediaType');
const { withIntakeDeadline } = require('./intake/intake.deadline');

/**
 * POST /v1/webhooks/:provider/:channel (e o alias da raiz) — M9-D211 3.2, M9-D212 3.1, M9-D213. A ordem é a do livro e qualquer desvio é bug:
 * 2 limite por IP e fornecedor, 3 connection do canal e parâmetros (webhooks.preflight.js), 4 tamanho do corpo (webhooks.rawBody.js), 5 verificador e assinatura sobre o
 * corpo bruto em tempo constante, 6 tipo de conteúdo e horário assinado (replay), 7 só então ler o JSON e conferir a estrutura, 8 gravar e responder. A rota só valida,
 * grava e responde: nenhuma regra de negócio, nenhuma chamada de rede; quem converte em evento interno é o worker (M9-D212).
 */
function verifyAll(verifier, secrets, rawBody, headers) {
  // Confere com todas as versões aceitas (corrente e graça) sem parar na primeira que casa.
  const resultados = secrets.map((secret) => verifier.verify({ rawBody, headers, secret, now: new Date() }));
  const bom = resultados.find((r) => r.ok);
  return bom || resultados[0] || { ok: false, reason: 'segredo ausente' };
}

const refuse = (intake, req, extra) => recordRefusal(intake.conn, { provider: intake.provider, channel: intake.channel, rawBody: req.rawBody, ip: req.ip, ...extra });

async function receiveWebhook(req, res) {
  const { provider, channel, conn, params, startedAt } = req.webhookIntake;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const prep = await withTenant(conn, async (transaction) => {
    const verifier = verifierFor(provider);
    if (!verifier) return { noVerifier: true };
    return { verifier, ...(await acceptedWebhookSecrets(conn, transaction)) };
  });
  if (prep.noVerifier) {
    logger.warn({ provider }, 'Webhook recusado: o fornecedor não tem verificador de assinatura.');
    throw noVerifier();
  }

  const verified = verifyAll(prep.verifier, prep.secrets, rawBody, req.headers);
  if (!verified.ok) {
    await recordSignatureFailure(conn, { provider, channel, rawBody, ip: req.ip, reason: prep.reason || verified.reason });
    throw signatureInvalid();
  }

  const adapter = adapterRegistry.instantiate(provider);
  let contentType;
  try {
    contentType = assertMediaType(req.headers, params.acceptedContentTypes, adapter ? adapter.webhookContentTypes() : []);
  } catch (err) {
    await refuse(req.webhookIntake, req, { code: err.code, httpStatus: err.statusCode, message: 'Webhook recusado: tipo de conteúdo não aceito.', reason: String(req.headers['content-type'] || 'ausente').slice(0, 60) });
    throw err;
  }

  const ctx = { groupId: conn.groupId, companyId: conn.companyId, userId: null };
  const dados = { provider, channel, rawBody, headers: req.headers, maxStoredBytes: req.webhookBodyLimit };
  let parsed;
  try {
    parsed = parseEvent(rawBody, req.headers, verified, { limits: params, contentType, provider, deriveEventId: Boolean(adapter && adapter.webhookDerivesEventId()), requireEventType: !adapter || adapter.webhookRequiresEventType() });
  } catch (err) {
    await refuse(req.webhookIntake, req, { code: err.code, httpStatus: err.statusCode, message: 'Webhook recusado: evento fora da janela de tempo permitida.', errorClass: 'SECURITY', severity: 'MEDIUM', reason: 'horário assinado fora da tolerância' });
    throw err;
  }
  const result = await withIntakeDeadline(startedAt, params.responseTimeoutMs, () => withTenant(conn, async (transaction) => {
    if (parsed.ok && foreignTenant(parsed.body, conn)) {
      return persistRejected(ctx, conn, { ...dados, body: parsed.body, eventType: parsed.eventType, reason: 'SCHEMA_INVALID', detail: 'O evento cita outra empresa ou grupo que não os do canal.', security: true }, transaction);
    }
    if (!parsed.ok) return persistRejected(ctx, conn, { ...dados, body: parsed.body, reason: parsed.reason, detail: parsed.detail }, transaction);
    return persistAccepted(ctx, conn, { ...dados, body: parsed.body, eventId: parsed.eventId, eventType: parsed.eventType }, transaction);
  }));
  return res.status(200).json(result.eventId ? { status: result.status, eventId: result.eventId } : { status: result.status });
}

module.exports = { receiveWebhook, verifyAll };
