'use strict';

/**
 * M9-D435 regra comum (a) — paginação das listagens do Marketing (publicações e templates): padrão 50 e máximo 200 por página, dois parâmetros da empresa lidos por
 * getSetting a cada chamada. Nasceu na M9-D410 (lista de publicações) e vale para toda listagem de /marketing; fica na raiz do módulo para as áreas não se importarem.
 */
const PAGE_DEFAULT_KEY = 'marketing.publicacoes.pagina_padrao';
const PAGE_MAX_KEY = 'marketing.publicacoes.pagina_maxima';
const PAGE_DEFAULTS = Object.freeze({ [PAGE_DEFAULT_KEY]: 50, [PAGE_MAX_KEY]: 200 });
const PAGE_SETTINGS_SCHEMA = {
  [PAGE_DEFAULT_KEY]: { type: 'integer', min: 1, max: 1000 },
  [PAGE_MAX_KEY]: { type: 'integer', min: 1, max: 1000 },
};

async function readPageLimits(tenant, transaction) {
  const { getSetting } = require('../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const read = async (key) => {
    const value = Number(await getSetting(key, tenant, transaction, PAGE_DEFAULTS[key]));
    return Number.isInteger(value) && value >= 1 ? value : PAGE_DEFAULTS[key];
  };
  const max = await read(PAGE_MAX_KEY);
  return { max, standard: Math.min(await read(PAGE_DEFAULT_KEY), max) };
}

module.exports = { PAGE_DEFAULT_KEY, PAGE_MAX_KEY, PAGE_DEFAULTS, PAGE_SETTINGS_SCHEMA, readPageLimits };
