'use strict';

/**
 * M9-D410 — paginação da listagem de publicações (livro: padrão 50, máximo 200). Parâmetros da aba Marketing, lidos por getSetting a cada chamada. Desde a M9-D435 os dois
 * parâmetros valem para todas as listagens do Marketing e vivem em marketing.pagination.js; este arquivo mantém os nomes que a área de publicações já usa.
 */
const { PAGE_DEFAULT_KEY, PAGE_MAX_KEY, PAGE_DEFAULTS, PAGE_SETTINGS_SCHEMA, readPageLimits } = require('../../marketing.pagination');

module.exports = { PAGE_DEFAULT_KEY, PAGE_MAX_KEY, SCHEDULE_SETTING_DEFAULTS: PAGE_DEFAULTS, SCHEDULE_SETTINGS_SCHEMA: PAGE_SETTINGS_SCHEMA, readPageLimits };
