'use strict';

/**
 * Parâmetro do relatório de rollback (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - migracao.rollback.itens_por_pagina: quantas operações do tipo o relatório lista por página (padrão 100).
 */
const PAGE_SIZE_KEY = 'migracao.rollback.itens_por_pagina';
const ROLLBACK_SETTING_DEFAULTS = Object.freeze({ [PAGE_SIZE_KEY]: 100 });
const ROLLBACK_SETTINGS_SCHEMA = { [PAGE_SIZE_KEY]: { type: 'integer', min: 1, max: 1000 } };

module.exports = { PAGE_SIZE_KEY, ROLLBACK_SETTING_DEFAULTS, ROLLBACK_SETTINGS_SCHEMA };
