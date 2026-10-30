'use strict';

/**
 * M9-D425 — parâmetro do kill switch do Marketing (aba Marketing de Configurações; padrão = parametros.csv). O livro não fixa o tamanho do motivo; o padrão
 * é o da demanda (10 caracteres) e a empresa pode ajustar. Fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread) + getSetting na hora do uso.
 */
const REASON_MIN_KEY = 'marketing.killswitch.motivo_min_caracteres';

const KILLSWITCH_SETTING_DEFAULTS = Object.freeze({ [REASON_MIN_KEY]: 10 });
const KILLSWITCH_SETTINGS_SCHEMA = Object.freeze({ [REASON_MIN_KEY]: { type: 'integer', min: 3, max: 500 } });

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../settings/settings.service').getSetting(...args);

/** Mínimo de caracteres do motivo na empresa; valor inválido volta ao padrão. */
async function readReasonMin(tenant, transaction) {
  const value = Number(await getSetting(REASON_MIN_KEY, tenant, transaction, KILLSWITCH_SETTING_DEFAULTS[REASON_MIN_KEY]));
  return Number.isInteger(value) && value >= 3 && value <= 500 ? value : KILLSWITCH_SETTING_DEFAULTS[REASON_MIN_KEY];
}

module.exports = { REASON_MIN_KEY, KILLSWITCH_SETTING_DEFAULTS, KILLSWITCH_SETTINGS_SCHEMA, readReasonMin };
