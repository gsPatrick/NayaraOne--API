'use strict';

// M9-D035 — leituras agregadas que a NAY Diretoria usa (funil, carteira de obras, estoque em risco): só contagens e totais, sem identificar registro.
const { getPipelineSummary } = require('../../crm/pipelineSummary.service');
const { getPortfolioProgress } = require('../../construction/portfolioSummary.service');
const { getStockRisks } = require('../../inventory/stockRisksSummary.service');
const { getSetting } = require('../../settings/settings.service');
const { DIRETORIA_KEYS, DIRETORIA_SETTING_DEFAULTS } = require('../agents/nay_diretoria/diretoria.settings');

const tenantOf = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId });

const crmPipeline = (transaction) => ({ getSummary: () => getPipelineSummary(transaction) });

function constructionPortfolio(transaction, scope) {
  return {
    async getProgress() {
      const limit = await getSetting(DIRETORIA_KEYS.portfolioMax, tenantOf(scope), transaction, DIRETORIA_SETTING_DEFAULTS[DIRETORIA_KEYS.portfolioMax]);
      return getPortfolioProgress(transaction, { limit: Number(limit) });
    },
  };
}

const inventoryRisks = (transaction, scope) => ({ getRisks: () => getStockRisks(tenantOf(scope), transaction) });

module.exports = { crmPipeline, constructionPortfolio, inventoryRisks };
