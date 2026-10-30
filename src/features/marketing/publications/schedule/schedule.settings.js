'use strict';

/**
 * M9-D410 — paginação da listagem de publicações (livro: padrão 50, máximo 200). Parâmetros da aba Marketing, lidos por getSetting a cada chamada.
 */
const PAGE_DEFAULT_KEY = 'marketing.publicacoes.pagina_padrao';
const PAGE_MAX_KEY = 'marketing.publicacoes.pagina_maxima';
const SCHEDULE_SETTING_DEFAULTS = Object.freeze({ [PAGE_DEFAULT_KEY]: 50, [PAGE_MAX_KEY]: 200 });
const SCHEDULE_SETTINGS_SCHEMA = {
  [PAGE_DEFAULT_KEY]: { type: 'integer', min: 1, max: 1000 },
  [PAGE_MAX_KEY]: { type: 'integer', min: 1, max: 1000 },
};

async function readPageLimits(tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const read = async (key) => {
    const value = Number(await getSetting(key, tenant, transaction, SCHEDULE_SETTING_DEFAULTS[key]));
    return Number.isInteger(value) && value >= 1 ? value : SCHEDULE_SETTING_DEFAULTS[key];
  };
  const max = await read(PAGE_MAX_KEY);
  return { max, standard: Math.min(await read(PAGE_DEFAULT_KEY), max) };
}

module.exports = { PAGE_DEFAULT_KEY, PAGE_MAX_KEY, SCHEDULE_SETTING_DEFAULTS, SCHEDULE_SETTINGS_SCHEMA, readPageLimits };
