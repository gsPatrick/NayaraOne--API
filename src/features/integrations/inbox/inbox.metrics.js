'use strict';

const client = require('prom-client');
const { register } = require('../../../utils/metrics');

/** Contador de eventos duplicados (M9-D203): o duplicado não grava linha, só incrementa esta métrica. */
const duplicatesTotal = register.getSingleMetric('nayaraone_api_integration_webhook_duplicates_total')
  || new client.Counter({
    name: 'nayaraone_api_integration_webhook_duplicates_total',
    help: 'Webhooks recebidos de novo (mesmo fornecedor e mesmo id de evento), ignorados pela caixa de entrada',
    labelNames: ['provider'],
    registers: [register],
  });

const countDuplicate = (providerCode) => duplicatesTotal.inc({ provider: String(providerCode).slice(0, 48) });
const duplicatesCount = async (providerCode) => {
  const { values } = await duplicatesTotal.get();
  const achado = values.find((v) => v.labels.provider === providerCode);
  return achado ? achado.value : 0;
};

module.exports = { countDuplicate, duplicatesCount };
