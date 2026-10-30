'use strict';

const levels = require('../../shared/destructive-actions/levels');
const { assertDebugAllowed } = require('../../shared/destructive-actions/debug.policy');

/**
 * Parâmetros do padrão de interface operacional (M9-D850 e M9-D852; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.ui.cache_fresco_s: até quantos segundos o último 200 de uma chamada conta como atual no estado OFFLINE do Front; passado disso a tela o marca "desatualizado" (padrão 60, o do livro). Quem lê é o Front (lib/asyncState/freshness.js).
 *  - governanca.ui.confirmacao_por_nivel: nível de confirmação de cada ação destrutiva (1 simples, 2 com impacto, 3 crítica), no formato `chave=nível; ...`; o padrão é o do livro (src/shared/destructive-actions). Lido pelo guarda de confirmação da API.
 *  - governanca.ui.exibir_debug: corpo de erro 500 com o campo `debug` (mensagem e stack) FORA de produção; desligado por padrão e proibido em produção. Lido por errorHandler.
 *  - governanca.acoes.impacto_validade_min: minutos de validade do impactToken (padrão 10, o do livro). Lido por impact.token.
 *  - governanca.acoes.impacto_itens_max: quantos itens afetados a tela lista no impacto (padrão 50). Lido pelo provedor de impacto.
 */
const CACHE_FRESH_KEY = 'governanca.ui.cache_fresco_s';
const LEVELS_KEY = levels.LEVELS_KEY;
const DEBUG_KEY = 'governanca.ui.exibir_debug';
const TOKEN_TTL_KEY = 'governanca.acoes.impacto_validade_min';
const ITEMS_MAX_KEY = 'governanca.acoes.impacto_itens_max';

const UI_SETTING_DEFAULTS = Object.freeze({
  [CACHE_FRESH_KEY]: 60,
  [LEVELS_KEY]: levels.defaultLevelsText(),
  [DEBUG_KEY]: false,
  [TOKEN_TTL_KEY]: 10,
  [ITEMS_MAX_KEY]: 50,
});

const UI_SETTINGS_SCHEMA = {
  [CACHE_FRESH_KEY]: { type: 'integer', min: 1, max: 86400 },
  [LEVELS_KEY]: { type: 'string', validate: levels.validateLevelsText },
  [DEBUG_KEY]: { type: 'boolean', validate: assertDebugAllowed },
  [TOKEN_TTL_KEY]: { type: 'integer', min: 1, max: 60 },
  [ITEMS_MAX_KEY]: { type: 'integer', min: 1, max: 200 },
};

module.exports = { CACHE_FRESH_KEY, LEVELS_KEY, DEBUG_KEY, TOKEN_TTL_KEY, ITEMS_MAX_KEY, UI_SETTING_DEFAULTS, UI_SETTINGS_SCHEMA };
