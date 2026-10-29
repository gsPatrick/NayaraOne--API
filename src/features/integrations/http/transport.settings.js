'use strict';

/** Parâmetros da saída das integrações (M9-D244): só o dicionário de SETTINGS_SCHEMA; a leitura está em egress.params.js. */
const TRANSPORT_SETTINGS_SCHEMA = Object.freeze({
  // INT-P056: enforce bloqueia host fora da lista (padrão em PRODUCTION e HOMOLOG); log só registra (padrão em SANDBOX e DEV).
  'integration.egress.mode': { type: 'string', enum: ['enforce', 'log'] },
});

module.exports = { TRANSPORT_SETTINGS_SCHEMA };
