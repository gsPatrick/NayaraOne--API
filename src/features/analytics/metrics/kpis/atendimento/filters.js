'use strict';

/**
 * M9-D672 / M9-D611 — filtro canônico (assinado) de cada KPI de Atendimento: os registros do módulo que reproduzem o número, no mês de São Paulo da data-base (do início do
 * mês, inclusivo, ao início do mês seguinte, exclusivo, como o read model, M9-D606). Avaliações e satisfação: pedidos de avaliação concluídos no mês (instante de conclusão;
 * sem ele, a última alteração); reclamações: casos abertos no mês; SLA: casos resolvidos no mês.
 */
const { saoPauloMidnight } = require('../../period');
const dates = require('../../period.dates');

function monthWindow(asOfDate) {
  const first = `${asOfDate.slice(0, 7)}-01`;
  return { from: saoPauloMidnight(first).toISOString(), to: saoPauloMidnight(dates.addMonthsFirstDay(first, 1)).toISOString() };
}

function supportFilterOf(code, asOfDate) {
  const window = monthWindow(asOfDate);
  const live = { deletedAt: null };
  const filters = {
    'sup.reviews': { status: ['COMPLETED'], equals: { ...live, monthFrom: window.from, monthTo: window.to } },
    'sup.satisfaction': { equals: { ...live, monthFrom: window.from, monthTo: window.to } },
    'sup.complaints_by_reason': { period: window, equals: live },
    'sup.sla_resolution': { period: window, status: ['RESOLVED'], equals: live },
  };
  return filters[code];
}

module.exports = { supportFilterOf, monthWindow };
