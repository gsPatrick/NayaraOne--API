'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { FLOW_KEYS: K, FLOW_SETTING_DEFAULTS: D } = require('./flow.settings');

const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= 1 ? Number(value) : fallback);

/** Parâmetros do fluxo na empresa (transação do tenant). Valor inválido volta ao padrão. */
async function readFlowParams(ctx, transaction) {
  const tenant = { groupId: ctx.groupId, companyId: ctx.companyId };
  const turns = await getSetting(K.maxTurns, tenant, transaction, D[K.maxTurns]);
  const total = await getSetting(K.totalTimeoutMs, tenant, transaction, D[K.totalTimeoutMs]);
  return { maxTurns: positive(turns, D[K.maxTurns]), totalTimeoutMs: positive(total, D[K.totalTimeoutMs]) };
}

module.exports = { readFlowParams };
