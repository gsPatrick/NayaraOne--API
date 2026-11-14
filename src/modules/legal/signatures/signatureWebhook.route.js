'use strict';

const { rawBodyMiddleware } = require('../../../features/integrations/webhooks/webhooks.rawBody');
const { receiveWebhook } = require('../../../features/integrations/webhooks/webhooks.handler');
const catchAsync = require('../../../utils/catchAsync');

/**
 * Rota literal do Guia §14 "POST /webhooks/signature/:provider | Webhook" (Caderno M5 §8 "Webhook do provider é
 * idempotente e validado"). Mesmos handlers já validados:
 *  - com `?channel=<canal>` (ou cabeçalho x-webhook-channel): a rota única de webhooks do framework, com o código do
 *    fornecedor de assinatura (verificação da assinatura no corpo bruto, caixa de entrada com UNIQUE por empresa +
 *    fornecedor + id externo do evento — duplicado não reaplica);
 *  - Clicksign sem canal: o webhook público do Clicksign (HMAC Content-Hmac do corpo bruto; tenant pela tabela de
 *    roteamento; assinatura já SIGNED não reaplica efeito) — mesmo de POST /v1/legal/webhooks/clicksign.
 * Fornecedor fora da lista, ou fornecedor sem canal que não é o Clicksign: segue para a rota única do Marco 9 (M9-D211), que já
 * atendia /v1/webhooks/signature/<x> antes desta rota existir — o mesmo 404 genérico INTEGRATION_WEBHOOK_UNKNOWN_CHANNEL, com o limite
 * de chamadas e o contador de webhook desconhecido (sem revelar quais fornecedores existem).
 */
const PROVIDER_CODES = Object.freeze({ clicksign: 'signature-clicksign', zapsign: 'signature-zapsign', sandbox: 'signature-sandbox', 'sandbox-alt': 'signature-alt-sandbox' });

/**
 * `framework` recebe as peças do framework de webhooks (verificação de assinatura no corpo bruto):
 * { webhookPreflight, legacyAlias } — injetadas na declaração da rota para a verificação ficar explícita.
 */
function signatureWebhookRoute({ webhookPreflight, legacyAlias }, clicksignPublicWebhook) {
  const legacy = legacyAlias('clicksign', clicksignPublicWebhook);
  const framework = [webhookPreflight, rawBodyMiddleware, catchAsync(receiveWebhook)];
  const run = (chain, req, res, next) => {
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      const fn = chain[i];
      i += 1;
      if (!fn) return next();
      try { return fn(req, res, step); } catch (e) { return next(e); }
    };
    step();
  };
  return (req, res, next) => {
    const key = String(req.params.provider || '').toLowerCase();
    const code = PROVIDER_CODES[key];
    if (!code) return next();
    const channel = (req.query && req.query.channel) || req.headers['x-webhook-channel'];
    if (channel) {
      req.params.provider = code;
      req.params.channel = String(channel);
      return run(framework, req, res, next);
    }
    if (key === 'clicksign') return run(legacy, req, res, next);
    return next();
  };
}

module.exports = { signatureWebhookRoute, PROVIDER_CODES };
