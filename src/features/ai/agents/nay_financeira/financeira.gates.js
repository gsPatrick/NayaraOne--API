'use strict';

// M9-D036 — `finance.proposePayment` está na allowlist da NAY Financeira DESABILITADA. Ela só passa a valer enquanto a empresa mantém
// `ia.financeira.permitir_proposta_pagamento` Ligado (a mesma chave que a M9-D019 confere ao criar a proposta); a allowlist da versão é
// imutável, então quem decide é o servidor a cada run, nunca o modelo.
const { getSetting } = require('../../../settings/settings.service');
const { APPROVAL_KEYS, APPROVAL_SETTING_DEFAULTS } = require('../../approval/approval.settings');
const { registerToolGate } = require('../toolGates');
const { CODE, PROPOSE_PAYMENT } = require('./financeira.policy');

const KEY = APPROVAL_KEYS.allowPaymentProposal;

/** A empresa liberou a proposta de pagamento? (padrão Desligado: o livro diz "sem pagar".) */
async function paymentProposalAllowed(tenant, transaction) {
  return (await getSetting(KEY, tenant, transaction, APPROVAL_SETTING_DEFAULTS[KEY])) === true;
}

function registerFinanceiraGates() {
  registerToolGate(CODE, PROPOSE_PAYMENT, (ctx, transaction) => paymentProposalAllowed(ctx, transaction));
}

module.exports = { paymentProposalAllowed, registerFinanceiraGates };
