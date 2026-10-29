'use strict';

const { getSetting } = require('../../settings/settings.service');
const { APPROVAL_KEYS: K, APPROVAL_SETTING_DEFAULTS: D } = require('./approval.settings');

async function readBool(key, ctx, transaction) {
  const raw = await getSetting(key, ctx, transaction, D[key]);
  return typeof raw === 'boolean' ? raw : D[key];
}

/** Parâmetros da empresa para a aprovação de ações; valor inválido volta ao padrão conservador (Desligado). */
async function readApprovalParams(ctx, transaction) {
  const [directLowRiskWrite, allowPaymentProposal] = await Promise.all([
    readBool(K.directLowRiskWrite, ctx, transaction), readBool(K.allowPaymentProposal, ctx, transaction),
  ]);
  return { directLowRiskWrite, allowPaymentProposal };
}

module.exports = { readApprovalParams };
