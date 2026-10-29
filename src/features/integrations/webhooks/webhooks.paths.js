'use strict';

/**
 * Caminhos públicos de webhook que passam pelo framework (M9-D211): a rota única e os quatro aliases dos fornecedores já configurados.
 * O app.js não aplica o parser de JSON a eles: o corpo chega bruto (webhooks.rawBody.js) e a assinatura vem antes de qualquer leitura.
 */
const UNIVERSAL = /^(?:\/v1)?\/webhooks\/[^/]+\/[^/]+\/?$/;
const LEGACY = [
  /^\/v1\/legal\/webhooks\/clicksign\/?$/,
  /^\/v1\/finance\/webhooks\/bank-payment\/?$/,
  /^\/v1\/procurement\/webhooks\/insurance\/?$/,
  /^\/v1\/correspondent\/webhooks\/financing\/[^/]+\/?$/,
];

const isFrameworkWebhookPath = (path, apiPrefix = '/api') => {
  const p = String(path || '');
  if (!p.startsWith(`${apiPrefix}/`)) return false;
  const resto = p.slice(apiPrefix.length);
  return UNIVERSAL.test(resto) || LEGACY.some((re) => re.test(resto));
};

module.exports = { isFrameworkWebhookPath };
