'use strict';

const AppError = require('../../../utils/AppError');

/** Parâmetros da publicação de páginas do site (M9-D259): só o dicionário de SETTINGS_SCHEMA; a leitura está em site.params.js. */
const SITE_SETTINGS_SCHEMA = Object.freeze({
  // Idioma da página publicada quando o pedido não informa um (a chave da página inclui o idioma).
  'integration.site.default_locale': {
    type: 'string',
    validate: (key, value) => {
      if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(value))) throw AppError.badRequest(`O valor de "${key}" deve ser um idioma como pt-BR ou en.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
});

module.exports = { SITE_SETTINGS_SCHEMA };
