'use strict';

const { getSetting } = require('../../settings/settings.service');
const { KEYS, CLOSURE_KINDS, closureKey, DEFAULTS } = require('./leaseObligations.settings');

/** Leitura dos parâmetros do ciclo das obrigações (dicionário e padrões em leaseObligations.settings.js). */
async function intParam(key, tenant, transaction, min, max) {
  const value = Number(await getSetting(key, tenant, transaction, DEFAULTS[key]));
  return Number.isInteger(value) && value >= min && value <= max ? value : DEFAULTS[key];
}

async function leaseObligationParams(tenant, transaction) {
  const blocks = {};
  for (const kind of CLOSURE_KINDS) {
    const value = await getSetting(closureKey(kind), tenant, transaction, DEFAULTS[closureKey(kind)]);
    blocks[kind] = value === true || value === 'true';
  }
  return {
    proofGraceDays: await intParam(KEYS.PROOF_GRACE_DAYS, tenant, transaction, 0, 60),
    reimbursementAlertDays: await intParam(KEYS.REIMBURSEMENT_ALERT_DAYS, tenant, transaction, 1, 365),
    transferDays: await intParam(KEYS.TRANSFER_DAYS, tenant, transaction, 1, 90),
    closureBlocks: blocks,
  };
}

module.exports = { leaseObligationParams };
