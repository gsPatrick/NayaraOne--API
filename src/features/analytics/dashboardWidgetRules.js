'use strict';

/**
 * M9-D601 — regras de entrada de um widget de painel (validadas no serviço, antes do banco).
 * O banco repete a regra de fórmula/SQL (gatilho ANA08) e a do metric_code obrigatório (CHECK).
 */

const AppError = require('../../utils/AppError');
const { hasForbiddenKey, MSG, invalid, requireOneOf, requireText, isPlainObject } = require('./analyticsStoreSupport');

const WIDGET_TYPES = ['KPI_CARD', 'TREND', 'TABLE', 'BAR', 'LIST_ALERTS', 'QUALITY_BANNER', 'BRIEF', 'COMMAND_BLOCK']; // COMMAND_BLOCK (M9-D685): um dos 6 blocos do Centro de Comando
const METRIC_WIDGET_TYPES = ['KPI_CARD', 'TREND', 'TABLE', 'BAR'];
const VALUE_NATURES = ['ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED'];
const METRIC_CODE_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const CODE = 'ANALYTICS_WIDGET_INVALID';

/** Valida e normaliza o widget; devolve as colunas prontas para gravar. */
function normalizeWidget(input) {
  requireOneOf(input.widgetType, WIDGET_TYPES, 'Tipo de widget', CODE);
  requireText(input.title, 'O título do widget', CODE);
  if (!Number.isInteger(input.position) || input.position < 0) throw invalid(CODE, 'A posição do widget deve ser um inteiro a partir de 0.');
  const valueNature = input.valueNature || 'ACTUAL';
  requireOneOf(valueNature, VALUE_NATURES, 'Natureza do valor', CODE);
  const config = input.config === undefined ? {} : input.config;
  if (!isPlainObject(config)) throw invalid(CODE, 'A configuração do widget deve ser um objeto.');
  if (hasForbiddenKey(config)) throw AppError.unprocessable(MSG.WIDGET_FORMULA, 'ANALYTICS_WIDGET_FORMULA_FORBIDDEN');
  const metricCode = input.metricCode == null ? null : input.metricCode;
  if (METRIC_WIDGET_TYPES.includes(input.widgetType) && metricCode == null) throw invalid(CODE, 'Este tipo de widget exige um indicador (metricCode).');
  if (metricCode != null && (typeof metricCode !== 'string' || !METRIC_CODE_RE.test(metricCode))) {
    throw invalid(CODE, 'O código do indicador deve seguir o formato dominio.nome_em_snake.');
  }
  return {
    position: input.position,
    widgetType: input.widgetType,
    metricCode,
    dimensionKey: input.dimensionKey || null,
    title: input.title.trim(),
    valueNature,
    drilldownEnabled: input.drilldownEnabled === true,
    config,
  };
}

module.exports = { WIDGET_TYPES, METRIC_WIDGET_TYPES, normalizeWidget };
