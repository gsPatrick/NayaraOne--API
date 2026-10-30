'use strict';

const AppError = require('../../../utils/AppError');
const { WHATSAPP_SETTINGS_SCHEMA } = require('./whatsapp.settings');

/**
 * Parâmetros da mensageria do CRM (M9-D229): só o dicionário de SETTINGS_SCHEMA; a leitura está em messaging.params.js. Padrões em Maturacao/demandas/parametros.csv.
 */
const MESSAGING_SETTINGS_SCHEMA = Object.freeze({
  // Código do país do telefone E.164 (livro: +55). O número enviado ao fornecedor precisa começar por ele.
  'integration.messaging.country_code': {
    type: 'string',
    validate: (key, value) => {
      if (!/^[1-9]\d{0,2}$/.test(value)) throw AppError.badRequest(`O valor de "${key}" deve ser o código do país só com dígitos (ex.: 55).`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Prazo (horas) da primeira ação da oportunidade criada para quem escreve pela primeira vez (lead provisório).
  'integration.messaging.inbound_lead_prazo_horas': { type: 'integer', min: 1, max: 720 },
  ...WHATSAPP_SETTINGS_SCHEMA,
});

module.exports = { MESSAGING_SETTINGS_SCHEMA };
