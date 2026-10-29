'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { PADROES, LIMITES, parseRoles } = require('./alerts.limits');

const inteiro = (v, padrao, lim) => (Number.isInteger(v) && v >= lim.min && v <= lim.max ? v : padrao);

async function readAlertParams(ctx, transaction) {
  const [repeat, papeis, circuito, intervalo] = await Promise.all([
    getSetting('integration.alert.repeat_min', ctx, transaction, PADROES.repeatMin),
    getSetting('integration.alert.notify_roles', ctx, transaction, PADROES.notifyRoles),
    getSetting('integration.alert.circuit_open_min', ctx, transaction, PADROES.circuitOpenMin),
    getSetting('integration.alert.evaluate_interval_s', ctx, transaction, PADROES.evaluateIntervalS),
  ]);
  return {
    repeatMin: inteiro(repeat, PADROES.repeatMin, LIMITES.repeatMin),
    notifyRoles: parseRoles(papeis) || parseRoles(PADROES.notifyRoles),
    circuitOpenMin: inteiro(circuito, PADROES.circuitOpenMin, LIMITES.circuitOpenMin),
    evaluateIntervalS: inteiro(intervalo, PADROES.evaluateIntervalS, LIMITES.evaluateIntervalS),
  };
}

module.exports = { PADROES, LIMITES, parseRoles, readAlertParams };
