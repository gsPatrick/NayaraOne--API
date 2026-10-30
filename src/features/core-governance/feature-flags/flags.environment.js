'use strict';

const { getSetting } = require('../../settings/settings.service');
const { FINOPS_SETTING_DEFAULTS } = require('../finops/finops.settings');

const KEY = 'governanca.finops.ambiente';

/** Ambiente desta instalação (parâmetro do FinOps, PROD por padrão): é o ambiente que a resolução usa quando o chamador não informa. */
const ENVIRONMENT_KEY = Object.freeze({
  key: KEY,
  read: async (tenant, transaction) => String(await getSetting(KEY, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction, FINOPS_SETTING_DEFAULTS[KEY])).toUpperCase(),
});

module.exports = { ENVIRONMENT_KEY };
