'use strict';

/** Parâmetros do registro de erros de integração (M9-D207): só o dicionário de SETTINGS_SCHEMA; a leitura está em errors.params.js. */
const ERRORS_SETTINGS_SCHEMA = Object.freeze({
  // INT-P037: janela (minutos) em que falhas repetidas sem referência de origem viram uma única linha.
  'integration.errors.group_window_min': { type: 'integer', min: 1, max: 1440 },
  // INT-P038: dias que o erro fica guardado antes do expurgo (feito por integration.purge_expired(), M9-D244).
  'integration.errors.retention_days': { type: 'integer', min: 1, max: 3650 },
  // Tentativas a partir das quais TRANSIENT e RATE_LIMIT deixam de ser LOW e viram HIGH (livro: "até esgotar tentativas").
  'integration.errors.exhausted_attempts': { type: 'integer', min: 1, max: 100 },
});

module.exports = { ERRORS_SETTINGS_SCHEMA };
