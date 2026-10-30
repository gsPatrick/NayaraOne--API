'use strict';

// M9-D038 — serviço que as tools da NAY Jurídica chamam (ctx.services.legalNay). O limite de itens vem da configuração da empresa.
const { getSetting } = require('../../../settings/settings.service');
const { JURIDICA_SETTING_DEFAULTS: D } = require('./juridica.settings');
const data = require('./juridica.data');
const clock = require('../../clock');

function legalNay(transaction, scope = {}) {
  const max = async () => Number(await getSetting('ia.nay_juridica.max_itens_lista', scope, transaction, D['ia.nay_juridica.max_itens_lista'])) || D['ia.nay_juridica.max_itens_lista'];
  return {
    getContractSummary: async (contractId) => data.contractSummary(contractId, transaction, clock.now(), await max()),
    compareVersions: async (contractId, from, to) => data.compareVersions(contractId, from, to, transaction, clock.now(), await max()),
    getRequirementsChecklist: async (contractId) => data.requirementsChecklist(contractId, transaction, clock.now(), await max()),
    getDeadlines: async (contractId) => data.contractDeadlines(contractId, transaction, clock.now(), await max()),
  };
}

module.exports = { legalNay };
