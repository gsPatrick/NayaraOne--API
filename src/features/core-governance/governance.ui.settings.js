'use strict';

/**
 * Parâmetros do padrão de estados de UI (M9-D850; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.ui.cache_fresco_s: até quantos segundos o último 200 de uma chamada conta como atual no estado OFFLINE do Front; passado disso a tela o marca "desatualizado" (padrão 60, o do livro).
 * Quem lê é o Front (lib/asyncState/freshness.js, GET /settings/:key); a API só declara, valida e guarda.
 */
const CACHE_FRESH_KEY = 'governanca.ui.cache_fresco_s';

const UI_SETTING_DEFAULTS = Object.freeze({
  [CACHE_FRESH_KEY]: 60,
});

const UI_SETTINGS_SCHEMA = {
  [CACHE_FRESH_KEY]: { type: 'integer', min: 1, max: 86400 },
};

module.exports = { CACHE_FRESH_KEY, UI_SETTING_DEFAULTS, UI_SETTINGS_SCHEMA };
