'use strict';

// M9-D036 — projeção de fluxo e anomalias para a NAY Financeira: serviços de leitura do Financeiro, sob o RLS do tenant.
const { getCashflowProjection } = require('../../finance/financeCashflowProjection.service');
const { getOpenAnomalies } = require('../../finance/financeAnomalySummary.service');
const { getSetting } = require('../../settings/settings.service');
const { FINANCEIRA_KEYS, FINANCEIRA_SETTING_DEFAULTS } = require('../agents/nay_financeira/financeira.settings');

function financeProjection(transaction, scope) {
  const tenant = { groupId: scope.groupId, companyId: scope.companyId };
  return {
    getCashflow: () => getCashflowProjection(transaction),
    async getAnomalies() {
      const limit = await getSetting(FINANCEIRA_KEYS.anomaliesMax, tenant, transaction, FINANCEIRA_SETTING_DEFAULTS[FINANCEIRA_KEYS.anomaliesMax]);
      return getOpenAnomalies(tenant, transaction, { limit: Number(limit) });
    },
  };
}

module.exports = { financeProjection };
