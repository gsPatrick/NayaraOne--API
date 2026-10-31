'use strict';

/** Parâmetros do contrato de adapters (M9-D209): só o dicionário de SETTINGS_SCHEMA; a leitura está em adapters.params.js. */
const ADAPTERS_SETTINGS_SCHEMA = Object.freeze({
  // INT-P040: tempo máximo (ms) do teste de saúde de um fornecedor.
  'integration.health.check_timeout_ms': { type: 'integer', min: 500, max: 120000 },
  // INT-P009 / INT-P010: tempo máximo (ms) de uma chamada de leitura e de uma chamada de escrita ao fornecedor.
  'integration.dispatch.timeout_ms.read': { type: 'integer', min: 1000, max: 300000 },
  'integration.dispatch.timeout_ms.write': { type: 'integer', min: 1000, max: 300000 },
  // INT-006 (M9-D216, N3): tentativas dentro de UMA chamada de leitura ou operação idempotente (cotação, pedido de token); 1 deixa toda repetição ao Dispatch Service.
  // Operação que altera estado (emissão) tem sempre uma tentativa, qualquer que seja este valor.
  'integration.dispatch.call_attempts.idempotent': { type: 'integer', min: 1, max: 5 },
});

module.exports = { ADAPTERS_SETTINGS_SCHEMA };
