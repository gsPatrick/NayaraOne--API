'use strict';

/**
 * M9-D670 / M9-D671 / M9-D611 — filtro canônico (assinado) de cada KPI de Marketing: os registros do módulo que reproduzem o número. Os KPIs de fluxo usam o mês de
 * São Paulo da data-base, do início do mês (inclusivo) ao início do seguinte (exclusivo), como o read model (M9-D606); a frequência usa os dias da janela que termina
 * na data-base (parâmetro analytics.frequencia.janela_dias).
 */
const { saoPauloMidnight } = require('../../period');
const dates = require('../../period.dates');

function monthWindow(asOfDate) {
  const first = `${asOfDate.slice(0, 7)}-01`;
  return { from: saoPauloMidnight(first).toISOString(), to: saoPauloMidnight(dates.addMonthsFirstDay(first, 1)).toISOString() };
}

/** Os `days` dias de calendário que terminam em `asOfDate` (inclusive), do início do primeiro ao início do dia seguinte. */
function trailingWindow(asOfDate, days) {
  return { from: saoPauloMidnight(dates.addDays(asOfDate, -(days - 1))).toISOString(), to: saoPauloMidnight(dates.addDays(asOfDate, 1)).toISOString() };
}

function mktFilterOf(code, asOfDate, settings = {}) {
  const month = { period: monthWindow(asOfDate) };
  const filters = {
    'mkt.campaigns': {},
    'mkt.cost': { ...month, status: ['SETTLED'] },
    'mkt.leads': month,
    'mkt.attribution': { ...month, status: ['LEAD_CREATED'] },
    'mkt.deliverability': { ...month, equals: { direction: 'OUTBOUND' } },
    'mkt.opt_out': { ...month, equals: { reason: 'OPT_OUT' } },
    'mkt.frequency': { period: trailingWindow(asOfDate, settings.frequencyWindowDays || 7), equals: { direction: 'OUTBOUND' } },
    'mkt.automations_blocked_failed': month,
  };
  return filters[code];
}

module.exports = { mktFilterOf, monthWindow, trailingWindow };
