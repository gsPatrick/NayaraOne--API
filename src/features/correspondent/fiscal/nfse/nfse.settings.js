'use strict';

const AppError = require('../../../../utils/AppError');

/** Parâmetros da NFS-e (M9-D241): só o dicionário de SETTINGS_SCHEMA; a leitura está em nfse.params.js. */
const NFSE_SETTINGS_SCHEMA = Object.freeze({
  // Série do RPS da empresa na prefeitura (o número do RPS é único dentro da série). Padrão "A".
  'correspondent.nfse.rps_series': {
    type: 'string',
    validate: (key, value) => {
      if (!/^[A-Za-z0-9]{1,8}$/.test(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ter de 1 a 8 letras ou números (ex.: A).`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
});

module.exports = { NFSE_SETTINGS_SCHEMA };
