'use strict';

const client = require('prom-client');
const { register } = require('../../../utils/metrics');

/** Contador webhook_signature_failures (M9-D211 passo 5): assinaturas recusadas por fornecedor. */
const NAME = 'nayaraone_api_integration_webhook_signature_failures_total';
const failures = register.getSingleMetric(NAME) || new client.Counter({
  name: NAME, help: 'Webhooks recusados por assinatura inválida (webhook_signature_failures)', labelNames: ['provider'], registers: [register],
});

const countSignatureFailure = (provider) => failures.inc({ provider: String(provider || '-').slice(0, 48) });
const signatureFailuresCount = async (provider) => {
  const { values } = await failures.get();
  const achado = values.find((v) => v.labels.provider === provider);
  return achado ? achado.value : 0;
};

module.exports = { countSignatureFailure, signatureFailuresCount };
