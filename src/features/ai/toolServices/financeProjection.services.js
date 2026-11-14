'use strict';

// M9-D036 — projeção de fluxo e anomalias para a NAY Financeira: serviços de leitura do Financeiro, sob o RLS do tenant.
const { getCashflowProjection } = require('../../../modules/finance/application/services/finance-cashflow-projection.service');
const { getOpenAnomalies } = require('../../../modules/finance/application/services/finance-anomaly-summary.service');
const { listCollectionSuggestions } = require('../../../modules/finance/application/services/finance-collection-suggestions.service');
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
    /** Sugestões de cobrança e renegociação (não é tool: só o caminho de regra do agente as lê e as transforma em recomendação). */
    async getCollectionSuggestions() {
      const limit = await getSetting(FINANCEIRA_KEYS.suggestionsMax, tenant, transaction, FINANCEIRA_SETTING_DEFAULTS[FINANCEIRA_KEYS.suggestionsMax]);
      const renegotiateAfterDays = await getSetting(FINANCEIRA_KEYS.renegotiateAfterDays, tenant, transaction, FINANCEIRA_SETTING_DEFAULTS[FINANCEIRA_KEYS.renegotiateAfterDays]);
      return listCollectionSuggestions(transaction, { limit: Number(limit), renegotiateAfterDays: Number(renegotiateAfterDays) });
    },
  };
}

module.exports = { financeProjection };
