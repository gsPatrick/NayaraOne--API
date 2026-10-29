'use strict';

/**
 * Parâmetros da alteração em massa (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dados.bulk.max_registros: teto de registros de um lote (padrão 5.000, valor do livro/demanda); acima disso 422 GOV_BULK_TOO_LARGE.
 *  - governanca.dados.bulk.motivo_minimo: mínimo de caracteres do motivo obrigatório (padrão 10, o mais conservador: o livro só exige motivo).
 *  - governanca.dados.bulk.pagina_tamanho: itens por página das consultas de lotes e de itens (padrão 50).
 */
const MAX_KEY = 'governanca.dados.bulk.max_registros';
const REASON_MIN_KEY = 'governanca.dados.bulk.motivo_minimo';
const PAGE_SIZE_KEY = 'governanca.dados.bulk.pagina_tamanho';

const BULK_SETTING_DEFAULTS = Object.freeze({ [MAX_KEY]: 5000, [REASON_MIN_KEY]: 10, [PAGE_SIZE_KEY]: 50 });
const BULK_SETTINGS_SCHEMA = {
  [MAX_KEY]: { type: 'integer', min: 1, max: 100000 },
  [REASON_MIN_KEY]: { type: 'integer', min: 1, max: 500 },
  [PAGE_SIZE_KEY]: { type: 'integer', min: 1, max: 200 },
};

module.exports = { MAX_KEY, REASON_MIN_KEY, PAGE_SIZE_KEY, BULK_SETTING_DEFAULTS, BULK_SETTINGS_SCHEMA };
