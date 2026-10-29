'use strict';

const { getSetting } = require('../../settings/settings.service');
const { BUDGET_KEYS, BUDGET_SETTING_DEFAULTS, parseThresholds } = require('./budgets.settings');

/** Lê os três parâmetros da empresa (nada fixo no código): { thresholds:[..], actionAt100, degradeFrom }. */
async function readBudgetParams(ctx, transaction) {
  const tenant = { groupId: ctx.groupId, companyId: ctx.companyId };
  const read = (key) => getSetting(key, tenant, transaction, BUDGET_SETTING_DEFAULTS[key]);
  // Em sequência: a transação do tenant é uma conexão só.
  const rawThresholds = await read(BUDGET_KEYS.thresholds);
  const actionAt100 = await read(BUDGET_KEYS.actionAt100);
  const degradeFrom = await read(BUDGET_KEYS.degradeFrom);
  return {
    thresholds: parseThresholds(rawThresholds) || parseThresholds(BUDGET_SETTING_DEFAULTS[BUDGET_KEYS.thresholds]),
    actionAt100: actionAt100 === 'DEGRADE' ? 'DEGRADE' : 'BLOCK',
    degradeFrom: Number.isInteger(Number(degradeFrom)) ? Number(degradeFrom) : BUDGET_SETTING_DEFAULTS[BUDGET_KEYS.degradeFrom],
  };
}

module.exports = { readBudgetParams };
