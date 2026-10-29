'use strict';

// M9-D038 — serviço que as tools da NAY Jurídica chamam (ctx.services.legalNay). O limite de itens vem da configuração da empresa.
const { getSetting } = require('../../../settings/settings.service');
const { JURIDICA_SETTING_DEFAULTS: D } = require('./juridica.settings');
const data = require('./juridica.data');

function legalNay(transaction, scope = {}) {
  const max = async () => Number(await getSetting('ia.nay_juridica.max_itens_lista', scope, transaction, D['ia.nay_juridica.max_itens_lista'])) || D['ia.nay_juridica.max_itens_lista'];
  return {
    getContractSummary: async (contractId) => data.contractSummary(contractId, transaction, new Date(), await max()),
    compareVersions: async (contractId, from, to) => data.compareVersions(contractId, from, to, transaction, new Date(), await max()),
    getRequirementsChecklist: async (contractId) => data.requirementsChecklist(contractId, transaction, new Date(), await max()),
    getDeadlines: async (contractId) => data.contractDeadlines(contractId, transaction, new Date(), await max()),
  };
}

module.exports = { legalNay };
