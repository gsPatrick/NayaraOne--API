'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { ROUTER_KEYS: K, ROUTER_SETTING_DEFAULTS: D } = require('./router.settings');

/** Parâmetros efetivos do roteador na empresa (chamar com a transação do tenant). Valor inválido volta ao padrão. */
async function readRouterParams(tenant, transaction) {
  const scope = { groupId: tenant.groupId, companyId: tenant.companyId };
  const small = Number(await getSetting(K.smallMaxTokens, scope, transaction, D[K.smallMaxTokens]));
  const confidence = Number(await getSetting(K.minConfidence, scope, transaction, D[K.minConfidence]));
  const escalate = await getSetting(K.escalate, scope, transaction, D[K.escalate]);
  return {
    smallMaxTokens: Number.isInteger(small) && small >= 1 ? small : D[K.smallMaxTokens],
    minConfidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : D[K.minConfidence],
    escalate: escalate !== false && escalate !== 'false',
  };
}

module.exports = { readRouterParams };
