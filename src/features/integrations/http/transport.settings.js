'use strict';

const { SSRF_SETTINGS_SCHEMA } = require('./ssrf/ssrf.settings');

/** Parâmetros da saída das integrações (M9-D244 e M9-D245): só o dicionário de SETTINGS_SCHEMA; a leitura está em egress.params.js e ssrf/ssrf.params.js. */
const TRANSPORT_SETTINGS_SCHEMA = Object.freeze({
  // INT-P056: enforce bloqueia host fora da lista (padrão em PRODUCTION e HOMOLOG); log só registra (padrão em SANDBOX e DEV).
  'integration.egress.mode': { type: 'string', enum: ['enforce', 'log'] },
  // Busca de URL de terceiro (M9-D245): esquemas, redirecionamentos, tamanho, hosts por fluxo, tempo, portas e tipos.
  ...SSRF_SETTINGS_SCHEMA,
});

module.exports = { TRANSPORT_SETTINGS_SCHEMA };
