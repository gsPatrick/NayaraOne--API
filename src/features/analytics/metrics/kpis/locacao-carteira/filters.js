'use strict';

/**
 * M9-D640 / M9-D611 — filtro canônico (assinado) de cada KPI da carteira de Locação: os registros que reproduzem o número. Contratos ativos: contratos de locação ACTIVE. Vacância: os
 * imóveis locáveis. Inadimplência da locação: as entradas próprias de contratos de locação com vencimento na janela (de hoje − janela + 1 até o fim do dia-base, datas de São Paulo,
 * início inclusivo e fim exclusivo, M9-D606), sem estorno nem cancelamento. Os tipos de contrato de locação são os de analytics.locacao.tipos_contrato.
 */
const { financeBounds, iso } = require('../../../read-models/financeHealth.dates');

function rentalPortfolioFilterOf(code, asOfDate, settings) {
  const { leaseTypes, worksStatuses } = settings;
  if (code === 'rent.active_contracts') return { status: ['ACTIVE'], equals: { deletedAt: null, leaseTypes } };
  if (code === 'rent.vacancy') return { equals: { deletedAt: null, leaseTypes, worksStatuses } };
  const bounds = financeBounds(asOfDate, settings.windowDays);
  return {
    period: { from: iso(bounds.windowStart), to: iso(bounds.dayEnd) }, status: ['PENDING', 'PARTIALLY_SETTLED', 'SETTLED'], nature: ['RECEIVABLE'],
    equals: { thirdParty: false, reversal: null, leaseTypes },
  };
}

module.exports = { rentalPortfolioFilterOf };
