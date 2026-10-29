'use strict';

const { LIMITES, RECHECK, CHAVES } = require('./circuitPolicy');

/**
 * Parâmetros do circuit breaker (M9-D217), derivados da política: limiares e limites vêm de circuitPolicy.js (sem número repetido).
 * A faixa de cada chave é a mesma validada ao salvar a política da connection.
 */
const CIRCUIT_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(Object.entries(CHAVES).map(([campo, chave]) => [chave, { type: 'integer', min: LIMITES[campo].min, max: LIMITES[campo].max }])),
  [RECHECK.key]: { type: 'integer', min: RECHECK.min, max: RECHECK.max },
});

module.exports = { CIRCUIT_SETTINGS_SCHEMA };
