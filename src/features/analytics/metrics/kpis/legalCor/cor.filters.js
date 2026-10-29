'use strict';

/**
 * M9-D661 / M9-D611 — filtro canônico (assinado) de cada KPI do Correspondente: os registros do módulo que reproduzem o número. Aprovação e tempo de
 * análise usam as decisões (primeiro registro aplicado APPROVED ou REJECTED de cada caso) do mês de São Paulo da data-base, do início do mês (inclusivo)
 * ao início do mês seguinte (exclusivo), como o read model (M9-D606). Estágios: todos os casos da empresa. Comissão: a esperada (status EXPECTED).
 */
const { saoPauloMidnight } = require('../../period');
const dates = require('../../period.dates');

function monthWindow(asOfDate) {
  const first = `${asOfDate.slice(0, 7)}-01`;
  return { from: saoPauloMidnight(first).toISOString(), to: saoPauloMidnight(dates.addMonthsFirstDay(first, 1)).toISOString() };
}

function corFilterOf(code, asOfDate) {
  const decisions = { period: monthWindow(asOfDate), status: ['APPROVED', 'REJECTED'], equals: { applied: true } };
  const filters = {
    'cor.cases_by_stage': {},
    'cor.approval_rate_by_provider': decisions,
    'cor.analysis_time': decisions,
    'cor.commission': { status: ['EXPECTED'] },
  };
  return filters[code];
}

module.exports = { corFilterOf, monthWindow };
