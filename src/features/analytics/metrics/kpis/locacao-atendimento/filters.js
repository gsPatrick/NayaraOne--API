'use strict';

/**
 * M9-D642 / M9-D611 — filtro canônico (assinado) de cada KPI de chamados, satisfação e repasses da Locação: os registros do módulo que reproduzem o número. Chamados: os de manutenção
 * de imóveis com contrato de locação, em aberto (OPEN, IN_PROGRESS). Satisfação: os registros de atendimento do mês de São Paulo da data-base (início do mês, inclusivo, ao início
 * do mês seguinte, exclusivo, M9-D606) de pessoas que são parte de contrato de locação. Repasses: os atrasados, pendentes (PENDING, APPROVED) com data prevista (fim do mês de referência + analytics.locacao.repasse_prazo_dias) anterior à data-base. Os tipos de contrato de locação são os de
 * analytics.locacao.tipos_contrato.
 */
const { saoPauloMidnight } = require('../../period');
const dates = require('../../period.dates');

function monthWindow(asOfDate) {
  const first = `${asOfDate.slice(0, 7)}-01`;
  return { from: saoPauloMidnight(first).toISOString(), to: saoPauloMidnight(dates.addMonthsFirstDay(first, 1)).toISOString() };
}

function rentalCareFilterOf(code, asOfDate, settings) {
  const live = { deletedAt: null };
  const leaseTypes = settings.leaseTypes;
  const window = monthWindow(asOfDate);
  const filters = {
    'rent.tickets': { status: ['OPEN', 'IN_PROGRESS'], equals: { ...live, leaseTypes } },
    'rent.satisfaction': { equals: { ...live, leaseTypes, monthFrom: window.from, monthTo: window.to } },
    'rent.repasses': { status: ['PENDING', 'APPROVED'], equals: { overdueBefore: asOfDate, repassDays: settings.repassDays } },
  };
  return filters[code];
}

module.exports = { rentalCareFilterOf };
