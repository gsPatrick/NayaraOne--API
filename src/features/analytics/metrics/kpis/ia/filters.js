'use strict';

/**
 * M9-D681 — filtro canônico (assinado) de cada KPI de IA: os registros do módulo de IA que reproduzem o número, no mês de São Paulo da data-base (do início do mês, inclusivo, ao início
 * do mês seguinte, exclusivo, como o read model, M9-D606). Custo: execuções concluídas do mês; qualidade: execuções da semana (segunda a domingo); orçamento: orçamentos ativos do mês;
 * chamadas bloqueadas: chamadas em estado BLOCKED do mês.
 */
const { saoPauloMidnight } = require('../../period');
const dates = require('../../period.dates');
const { weekStartOf } = require('./rows');

const window = (from, to) => ({ from: saoPauloMidnight(from).toISOString(), to: saoPauloMidnight(to).toISOString() });

function iaFilterOf(code, asOfDate) {
  const first = `${asOfDate.slice(0, 7)}-01`;
  const month = window(first, dates.addMonthsFirstDay(first, 1));
  const week = weekStartOf(asOfDate);
  const filters = {
    'ai.cost_by_agent': { period: month, status: ['COMPLETED'] },
    'ai.quality_scores': { period: window(week, dates.addDays(week, 7)) },
    'ai.budget': { period: month, status: ['ACTIVE'] },
    'ai.tool_calls_blocked': { period: month, status: ['BLOCKED'] },
  };
  return filters[code];
}

module.exports = { iaFilterOf };
