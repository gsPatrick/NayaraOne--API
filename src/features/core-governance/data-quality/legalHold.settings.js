'use strict';

/**
 * Parâmetros da retenção legal (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). A trava em si NÃO tem parâmetro que a desligue
 * (livro: "legal_hold sempre prevalece"); só o tamanho da página da consulta e o limite de itens do escopo de uma retenção variam.
 */
const KEYS = Object.freeze({ PAGINA: 'governanca.legal_hold.pagina_tamanho', ESCOPO_MAX: 'governanca.legal_hold.escopo_max_itens' });

const LEGAL_HOLD_SETTING_DEFAULTS = Object.freeze({ [KEYS.PAGINA]: 50, [KEYS.ESCOPO_MAX]: 50 });
const LEGAL_HOLD_SETTINGS_SCHEMA = {
  [KEYS.PAGINA]: { type: 'integer', min: 1, max: 200 },
  [KEYS.ESCOPO_MAX]: { type: 'integer', min: 1, max: 500 },
};

module.exports = { KEYS, LEGAL_HOLD_SETTING_DEFAULTS, LEGAL_HOLD_SETTINGS_SCHEMA };
