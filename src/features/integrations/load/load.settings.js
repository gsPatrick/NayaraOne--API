'use strict';

/**
 * Parâmetros do teste de carga das integrações (M9-D255 3.3, INT-P098 a INT-P100 e dois do tamanho da carga): só o dicionário de SETTINGS_SCHEMA; a
 * leitura com os padrões está em load.params.js. São o TAMANHO da carga, nunca uma meta de desempenho.
 */
const LOAD_INTEGRATION_SETTINGS_SCHEMA = Object.freeze({
  'integration.load.webhooks_per_s': { type: 'integer', min: 1, max: 1000 },
  'integration.load.dispatches_per_s': { type: 'integer', min: 1, max: 1000 },
  'integration.load.duration_min': { type: 'integer', min: 1, max: 60 },
  // Parte dos webhooks e dos envios que o teste repete de propósito (reentrega do fornecedor e repetição da intenção).
  'integration.load.duplicate_percent': { type: 'integer', min: 0, max: 90 },
  // Quantas requisições o gerador de carga mantém ao mesmo tempo.
  'integration.load.concurrency': { type: 'integer', min: 1, max: 200 },
});

module.exports = { LOAD_INTEGRATION_SETTINGS_SCHEMA };
