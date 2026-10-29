'use strict';

/** Parâmetros dos envios (M9-D205): só o dicionário de SETTINGS_SCHEMA; a leitura está em dispatch.params.js. */
const DISPATCH_SETTINGS_SCHEMA = Object.freeze({
  // INT-P011: segundos em SENDING sem resposta até o recuperador mandar o envio para UNKNOWN.
  'integration.dispatch.sending_stale_s': { type: 'integer', min: 10, max: 86400 },
  // INT-P012: dias que um envio CONFIRMED ou CANCELLED fica guardado.
  'integration.dispatch.retention_days': { type: 'integer', min: 1, max: 3650 },
  // INT-P013: dias até o conteúdo enviado virar só o hash.
  'integration.dispatch.payload_retention_days': { type: 'integer', min: 1, max: 3650 },
  // INT-P004: tentativas máximas de um envio novo (o retry humano soma 3).
  'integration.retry.max_attempts': { type: 'integer', min: 1, max: 50 },
  // M9-D214 3.2: de quantos em quantos segundos o worker de envios roda, quantos envios pega por rodada e quanto espera antes de
  // reconferir uma conexão parada (PAUSED, DISABLED, AUTH_FAILED ou sem adaptador) sem gastar tentativa.
  'integration.dispatch.worker_interval_s': { type: 'integer', min: 1, max: 3600 },
  'integration.dispatch.worker_batch_size': { type: 'integer', min: 1, max: 500 },
  'integration.dispatch.blocked_recheck_s': { type: 'integer', min: 5, max: 86400 },
});

module.exports = { DISPATCH_SETTINGS_SCHEMA };
