'use strict';

/**
 * M9-D702 — parâmetro do administrador da API de métricas (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.metrica.dimensao_max_itens   quantas linhas da decomposição por dimensão (`?dimension=`) a resposta traz; passou disso, `truncated: true`.
 *                                          O livro não limita; padrão 50 (regra inferida: resposta de tela, não exportação).
 * Arquivo sem dependência de settings.service no topo (evita ciclo; a leitura usa import tardio).
 */
const KEYS = Object.freeze({ dimensionMaxItems: 'analytics.metrica.dimensao_max_itens' });
const QUERY_DEFAULTS = Object.freeze({ [KEYS.dimensionMaxItems]: 50 });
const QUERY_SETTINGS_SCHEMA = Object.freeze({ [KEYS.dimensionMaxItems]: { type: 'integer', min: 1, max: 500 } });

async function readDimensionMaxItems(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(KEYS.dimensionMaxItems, { companyId: scope.companyId, groupId: scope.groupId }, transaction, QUERY_DEFAULTS[KEYS.dimensionMaxItems]);
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : QUERY_DEFAULTS[KEYS.dimensionMaxItems];
}

module.exports = { KEYS, QUERY_DEFAULTS, QUERY_SETTINGS_SCHEMA, readDimensionMaxItems };
