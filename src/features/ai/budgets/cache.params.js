'use strict';

const { getSetting } = require('../../settings/settings.service');
const { CACHE_KEYS: K, CACHE_SETTING_DEFAULTS: D } = require('./cache.settings');

/** Parâmetros efetivos do cache na empresa (chamar com a transação do tenant). Valor inválido volta ao padrão. */
async function readCacheParams(tenant, transaction) {
  const scope = { groupId: tenant.groupId, companyId: tenant.companyId };
  const enabled = await getSetting(K.enabled, scope, transaction, D[K.enabled]);
  const ttl = Number(await getSetting(K.ttlSeconds, scope, transaction, D[K.ttlSeconds]));
  return { enabled: enabled === true || enabled === 'true', ttlSeconds: Number.isInteger(ttl) && ttl >= 1 ? ttl : D[K.ttlSeconds] };
}

module.exports = { readCacheParams };
