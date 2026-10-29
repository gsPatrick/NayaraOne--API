'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { FALLBACK_KEYS: K, FALLBACK_SETTING_DEFAULTS: D } = require('./fallback.settings');

/** Parâmetros efetivos do fallback na empresa (chamar com a transação do tenant). Valor inválido volta ao padrão. */
async function readFallbackParams(tenant, transaction) {
  const scope = { groupId: tenant.groupId, companyId: tenant.companyId };
  const hops = Number(await getSetting(K.maxHops, scope, transaction, D[K.maxHops]));
  const green = await getSetting(K.requireGreen, scope, transaction, D[K.requireGreen]);
  return {
    maxHops: Number.isInteger(hops) && hops >= 1 ? hops : D[K.maxHops],
    requireGreen: green !== false && green !== 'false',
  };
}

module.exports = { readFallbackParams };
