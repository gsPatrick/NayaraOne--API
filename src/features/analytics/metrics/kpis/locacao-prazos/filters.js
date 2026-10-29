'use strict';

/**
 * M9-D641 / M9-D611 — filtro canônico (assinado) de cada KPI de prazos da Locação: os registros do módulo que reproduzem o número. Garantias: ativas, de contratos de locação ACTIVE,
 * com vencimento de hoje até antes de hoje+30 (datas de calendário de São Paulo, início inclusivo e fim exclusivo, M9-D606). Obrigações: exigências pendentes de contratos de
 * locação não encerrados. Vistorias: as pendentes (não concluídas nem canceladas) de contratos de locação. Os tipos de contrato de locação são os de analytics.locacao.tipos_contrato.
 */
const dates = require('../../period.dates');

function rentalFilterOf(code, asOfDate, settings) {
  const live = { deletedAt: null };
  const leaseTypes = settings.leaseTypes;
  const filters = {
    'rent.guarantees_expiring': { status: ['ACTIVE'], equals: { ...live, windowFrom: asOfDate, windowTo: dates.addDays(asOfDate, 30), leaseTypes } },
    'rent.obligations_pending': { status: ['PENDING'], equals: { leaseTypes } },
    'rent.inspections_keys': { equals: { ...live, leaseTypes } },
  };
  return filters[code];
}

module.exports = { rentalFilterOf };
