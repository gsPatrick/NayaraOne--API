'use strict';

/**
 * M9-D702 (3.1) e M9-D694 — `compareTo`: variação do período consultado contra `previous_period` (mesma duração imediatamente antes; meses inteiros
 * comparam meses inteiros, M9-D606) ou `same_period_last_year` (as mesmas datas um ano antes; mês inteiro compara o mesmo mês). A conta é a da
 * M9-D694 (briefs/variation.service: decimal exato, ponta a ponta pelo registro de métricas); aqui só se escolhe o período e se apresenta o resultado.
 * Sem registro numa das pontas a leitura continua e a variação sai `available: false` com o motivo (nunca um número inventado).
 */
const AppError = require('../../../utils/AppError');
const { computeVariation } = require('../briefs/variation.service');
const { formatValue } = require('../dashboards/dashboard.format');
const { fromDates } = require('./period');
const { previousPeriod } = require('./period.compare');
const dates = require('./period.dates');

const KINDS = Object.freeze(['previous_period', 'same_period_last_year']);
const NO_BASE = 'Sem registro do período de comparação.';

function assertCompareKind(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !KINDS.includes(value)) {
    throw AppError.badRequest('Comparação inválida. Use previous_period ou same_period_last_year.', 'ANALYTICS_COMPARE_INVALID');
  }
  return value;
}

/** Mesma data um ano antes; 29/02 vira 28/02 quando o ano anterior não é bissexto. */
function yearBack(date) {
  const { y, m, d } = dates.parseDate(date);
  return dates.key(y - 1, m, Math.min(d, dates.lastDayOfMonth(y - 1, m)));
}

function lastYearPeriod(period) {
  const start = dates.parseDate(period.startDate);
  const end = dates.parseDate(period.endDate);
  const wholeMonths = start.d === 1 && end.d === dates.lastDayOfMonth(end.y, end.m);
  const endDate = wholeMonths ? dates.key(end.y - 1, end.m, dates.lastDayOfMonth(end.y - 1, end.m)) : yearBack(period.endDate);
  return fromDates(yearBack(period.startDate), endDate, endDate, period.kind);
}

const comparisonPeriod = (kind, period) => (kind === 'previous_period' ? previousPeriod(period) : lastYearPeriod(period));
const periodView = (p) => ({ startDate: p.startDate, endDate: p.endDate, asOfDate: p.asOfDate });

/** Bloco `variation` da resposta. `unit` formata os textos; `period` é o consultado e `asOfDate` a sua data-base. */
async function buildVariation({ ctx, definition, companyId, kind, period, asOfDate, unit }, transaction) {
  const previous = comparisonPeriod(kind, period);
  const current = { startDate: period.startDate, endDate: period.endDate, asOfDate };
  const out = await computeVariation({ ctx, definition, companyId, periodCurrent: current, periodPrevious: previous }, transaction);
  const v = out.variation;
  if (!v) {
    return {
      compareTo: kind, available: false, reason: NO_BASE, current: null, previous: null, absolute: null, percent: null, percentFormatted: null,
      previousFormatted: null, absoluteFormatted: null, periodCurrent: periodView(current), periodPrevious: periodView(previous),
    };
  }
  return {
    compareTo: kind, available: true, ...v, previousFormatted: formatValue(unit, v.previous), absoluteFormatted: formatValue(unit, v.absolute),
    percentFormatted: v.percent === null ? null : formatValue('PERCENT', v.percent),
  };
}

module.exports = { KINDS, assertCompareKind, buildVariation, comparisonPeriod };
