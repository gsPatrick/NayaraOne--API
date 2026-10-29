'use strict';

/**
 * M9-D633 — pacote dos três KPIs de Radar matches, captação por corretor e conversão por corretor: definições, leitura dos read models, entradas das
 * fórmulas, filtro canônico da origem e o contexto (limites de qualidade do administrador). O motor (commercial.entries) só junta pacotes.
 */
const { DEFINITIONS } = require('./commercial.defs.radarCorretores');
const { loadRows } = require('./commercial.rows.radarCorretores');
const { INPUTS, PARAMS, SNAPSHOT_KEY, POSITION_CODES } = require('./commercial.inputs.radarCorretores');
const { readCorretoresKpiParams } = require('../../read-models/corretoresKpi.settings');
require('../sourceSpecs.commercial.corretores');

/** Limites de qualidade vigentes para a empresa: analytics.qualidade.max_sem_corretor_pct e analytics.qualidade.min_amostra. */
const context = (scope, transaction) => readCorretoresKpiParams(scope, transaction);

/** Filtro canônico (M9-D611) de cada KPI: registro excluído fica fora, como nos read models; o período é o da janela. */
function filters(window) {
  const period = { from: window.from, to: window.to };
  const live = { deletedAt: null };
  return {
    'radar.matches': { period, equals: { eventType: 'radar.matched' } },
    'crm.broker_capture': { period, equals: live },
    'crm.broker_conversion': { period, status: ['CLOSED_LOST', 'CLOSED_WON'], equals: live },
  };
}

module.exports = { name: 'radarCorretores', definitions: DEFINITIONS, positionCodes: POSITION_CODES, loadRows, inputs: INPUTS, params: PARAMS, snapshotKey: SNAPSHOT_KEY, context, filters };
