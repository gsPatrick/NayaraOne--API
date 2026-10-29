'use strict';

/**
 * M9-D702 (3.3) — parâmetros de consulta aceitos pelas rotas de leitura do BI. Parâmetro fora da lista é 400 ANALYTICS_QUERY_PARAM_UNKNOWN
 * (rejeita erro de digitação em vez de ignorar). O nome devolvido na mensagem é cortado e limpo de caracteres de controle.
 */
const AppError = require('../../../utils/AppError');

const PERIOD_PARAMS = Object.freeze(['period', 'month', 'quarter', 'year', 'from', 'to', 'asOf']);
const METRIC_PARAMS = Object.freeze(['companyId', 'groupId', ...PERIOD_PARAMS, 'dimension', 'dimensionValue', 'compareTo']);
const DASHBOARD_PARAMS = Object.freeze(['companyId', ...PERIOD_PARAMS, 'bloco']); // `bloco` (M9-D685): o Centro de Comando mostra por inteiro o bloco pedido em "Ver todos"
const MAX_NAME = 60;

function assertKnownParams(query, allowed) {
  for (const name of Object.keys(query || {})) {
    if (!allowed.includes(name)) {
      const shown = name.replace(/[^\p{L}\p{N}_.[\]-]/gu, '').slice(0, MAX_NAME);
      throw AppError.badRequest(`Parâmetro de consulta desconhecido: ${shown}.`, 'ANALYTICS_QUERY_PARAM_UNKNOWN', { param: shown });
    }
  }
}

module.exports = { PERIOD_PARAMS, METRIC_PARAMS, DASHBOARD_PARAMS, assertKnownParams };
