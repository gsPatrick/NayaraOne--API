'use strict';

/**
 * M9-D695 — período pedido pela NAY: texto fechado AAAA-MM, AAAA-Qn, AAAA ou AAAA-MM-DD, resolvido pelo resolvedor único do BI
 * (M9-D606, calendário de São Paulo). A data-base é o fim do período, ou hoje quando o período ainda não terminou.
 */
const AppError = require('../../../utils/AppError');
const { resolvePeriod, resolveAsOf, clock } = require('../metrics');

const PERIOD_PATTERN = '^(\\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\\d|3[01]))?|\\d{4}-Q[1-4]|\\d{4})$';
const PERIOD_RE = new RegExp(PERIOD_PATTERN);

function resolveNayPeriod(text) {
  const value = String(text || '');
  if (!PERIOD_RE.test(value)) throw AppError.badRequest('Período inválido. Use AAAA-MM, AAAA-Qn, AAAA ou AAAA-MM-DD.', 'ANALYTICS_PERIOD_INVALID');
  const today = clock.businessToday();
  let period;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    resolveAsOf(value); // data futura: 400 ANALYTICS_AS_OF_FUTURE
    period = resolvePeriod({ from: value, to: value, asOf: value });
  } else if (/-Q/.test(value)) {
    period = resolvePeriod({ quarter: value, asOf: today });
  } else if (/^\d{4}$/.test(value)) {
    period = resolvePeriod({ year: value, asOf: today });
  } else {
    period = resolvePeriod({ month: value, asOf: today });
  }
  if (period.startDate > today) throw AppError.badRequest('A data-base não pode estar no futuro.', 'ANALYTICS_AS_OF_FUTURE');
  const asOfDate = period.endDate < today ? period.endDate : today;
  return { label: period.label, startDate: period.startDate, endDate: period.endDate, asOfDate };
}

module.exports = { PERIOD_PATTERN, resolveNayPeriod };
