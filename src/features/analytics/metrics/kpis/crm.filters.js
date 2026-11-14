'use strict';

/**
 * M9-D630 / M9-D631 / M9-D611 — filtro canônico (assinado) de cada KPI do funil: os registros de crm.opportunities que reproduzem o número. Período em
 * instantes (meia-noite de São Paulo, início inclusivo e fim exclusivo) do mês da data-base até o fim do dia-base (M9-D606). Oportunidade excluída fica
 * fora, como nos read models. Os marcadores crmClosedFrom/To e crmTaskDueFrom alimentam as condições fixas da origem (sourceSpecs.crm).
 */
const { saoPauloMidnight } = require('../period');

/** Limites ISO do período e da regra "data posterior a hoje" da próxima ação. includeToday vem do parâmetro analytics.comercial.proxima_acao_inclui_hoje. */
function windowOf(asOfDate, includeToday) {
  return {
    from: saoPauloMidnight(`${asOfDate.slice(0, 7)}-01`).toISOString(),
    to: saoPauloMidnight(asOfDate, 1).toISOString(),
    taskDueFrom: saoPauloMidnight(asOfDate, includeToday ? 0 : 1).toISOString(),
  };
}

function filtersOf(asOfDate, includeToday) {
  const w = windowOf(asOfDate, includeToday);
  const period = { from: w.from, to: w.to };
  const live = { deletedAt: null };
  return {
    periodStart: `${asOfDate.slice(0, 7)}-01`,
    byCode: {
      'crm.leads_by_origin': { period, equals: live },
      'crm.first_response_time': { period, equals: live },
      'crm.opportunities_by_stage': { equals: { ...live, crmClosedFrom: w.from, crmClosedTo: w.to } },
      'crm.conversion_rate': { period, status: ['LOST', 'WON'], equals: live },
      'crm.loss_reasons': { period, status: ['LOST'], equals: live },
      'crm.portfolio_without_next_action': { equals: { ...live, crmTaskDueFrom: w.taskDueFrom } },
    },
  };
}

module.exports = { filtersOf, windowOf };
