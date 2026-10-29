'use strict';

/**
 * M9-D632 — pacote dos cinco KPIs de visitas, propostas, imóveis ativos, imóveis sem venda por período e mudanças de preço: definições, leitura dos read
 * models, entradas das fórmulas, filtro canônico da origem e o contexto (faixas de dias do administrador). O motor (commercial.entries) só junta pacotes.
 */
const { DEFINITIONS } = require('./commercial.defs.visitsImoveis');
const { loadRows } = require('./commercial.rows.visitsImoveis');
const { INPUTS, PARAMS, SNAPSHOT_KEY, POSITION_CODES } = require('./commercial.inputs.visitsImoveis');
const { readComercialParams } = require('../../read-models/comercial.settings');
const { bandLabels } = require('../../read-models/comercial-imoveis/portfolio');
require('../sourceSpecs.commercial.imoveis');

/** Faixas de "imóvel sem venda" vigentes para a empresa (parâmetro analytics.imoveis.faixas_sem_venda_dias), como rótulos na ordem. */
async function context(scope, transaction) {
  return { bandLabels: bandLabels((await readComercialParams(scope, transaction)).bands) };
}

/** Filtro canônico (M9-D611) de cada KPI: registro excluído fica fora, como nos read models; o período é o da janela. */
function filters(window) {
  const period = { from: window.from, to: window.to };
  const live = { deletedAt: null };
  return {
    'crm.visits': { period, equals: live },
    'crm.proposals': { period, equals: live },
    'prop.active_properties': { equals: live },
    'prop.without_sale_by_period': { period: { from: null, to: window.to }, equals: live },
    'prop.price_changes': { period },
  };
}

module.exports = { name: 'visitsImoveis', definitions: DEFINITIONS, positionCodes: POSITION_CODES, loadRows, inputs: INPUTS, params: PARAMS, snapshotKey: SNAPSHOT_KEY, context, filters };
