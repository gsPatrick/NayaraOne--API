'use strict';

/** Parâmetros dos contract tests dos adapters (M9-D222): só o dicionário de SETTINGS_SCHEMA; a leitura está em contract.params.js. */
const CONTRACT_SETTINGS_SCHEMA = Object.freeze({
  // Por quantos dias o relatório de contract tests de um adapter vale para liberar a connection (o livro exige o relatório, sem dizer a validade).
  'integration.contract.report_validity_days': { type: 'integer', min: 1, max: 365 },
});

module.exports = { CONTRACT_SETTINGS_SCHEMA };
