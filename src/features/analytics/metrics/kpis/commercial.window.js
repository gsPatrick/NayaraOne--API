'use strict';

/**
 * M9-D632 / M9-D633 / M9-D611 — janela de cálculo dos KPIs de Comercial e Imóveis: o mês de São Paulo da data-base, do dia 1 até o fim do dia-base (M9-D606).
 * Em instantes de meia-noite de São Paulo, início inclusivo e fim exclusivo, para o filtro canônico (assinado) da origem de cada KPI.
 */
const { saoPauloMidnight } = require('../period');

function windowOf(asOfDate) {
  return {
    periodStart: `${asOfDate.slice(0, 7)}-01`,
    from: saoPauloMidnight(`${asOfDate.slice(0, 7)}-01`).toISOString(),
    to: saoPauloMidnight(asOfDate, 1).toISOString(),
  };
}

module.exports = { windowOf };
