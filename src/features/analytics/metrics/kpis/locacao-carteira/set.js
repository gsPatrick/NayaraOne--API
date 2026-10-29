'use strict';

/** M9-D640 — conjunto de KPIs da carteira de Locação (definições, leitura dos read models, entradas e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./definitions');
const { loadRentalPortfolioRows, RENTAL_PORTFOLIO_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { rentalPortfolioFilterOf } = require('./filters');
const { readLocacaoParams } = require('../../../read-models/locacao.settings');
const { readOverdueWindowDays } = require('../../../read-models/financeHealth.settings');
const { readOverdueBandLimits } = require('../../../read-models/financeDelinquency.settings');
const { readRentBandLimits, readRentalPortfolioOwner } = require('../../../read-models/locacaoCarteiraKpi.settings');
require('../../sourceSpecs.rentalPortfolio');

/** Parâmetros da empresa: tipos de contrato de locação, situações de obra que tiram o imóvel do locável, janela e faixas de atraso e faixas de valor do aluguel. */
async function readParams(scope, transaction) {
  return {
    ...(await readLocacaoParams(scope, transaction)), worksStatuses: ['ACTIVE', 'PAUSED', 'FINAL_INSPECTION'], windowDays: await readOverdueWindowDays(scope, transaction),
    overdueBands: await readOverdueBandLimits(scope, transaction), rentBands: await readRentBandLimits(scope, transaction),
  };
}

module.exports = createKpiSet({
  name: 'rental_portfolio', definitions: DEFINITIONS, readOwner: readRentalPortfolioOwner, readParams, loadRows: loadRentalPortfolioRows, inputs: INPUTS, params: PARAMS,
  filterOf: rentalPortfolioFilterOf, periodStart: (asOfDate) => asOfDate, watched: RENTAL_PORTFOLIO_READ_MODELS,
});
