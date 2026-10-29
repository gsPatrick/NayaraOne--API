'use strict';

// M9-D036 — pacote da NAY Financeira: cadastro, fronteira ("sem pagar"), portão da proposta de pagamento, resolvedores RULE e números.
const policy = require('./financeira.policy');
const { FINANCEIRA_KEYS: K, FINANCEIRA_SETTING_DEFAULTS, FINANCEIRA_SETTINGS_SCHEMA } = require('./financeira.settings');
const { RESOLVERS } = require('./financeira.resolvers');
const { CASES } = require('./financeira.golden');
const { registerFinanceiraNumbers } = require('./financeira.numbers');
const { registerFinanceiraGates, paymentProposalAllowed } = require('./financeira.gates');
const { registerAgentScope, wireScopeGuard } = require('../scope');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');

const KEY = Object.freeze({
  PAGAR: K.forbidPay, LIQUIDAR: K.forbidSettle, ALTERAR_FAVORECIDO: K.forbidPayee, ALTERAR_CONTA_BANCARIA: K.forbidBankAccount, FECHAR_PERIODO: K.forbidClosePeriod, CRIAR_LANCAMENTO: K.forbidCreateEntry,
});

/**
 * "Pague o fornecedor X": com `ia.financeira.permitir_proposta_pagamento` Desligado (padrão) a recusa orienta a rota humana; Ligado, o pedido segue
 * para a conversa e, no máximo, vira uma proposta PENDING (D019). As demais proibições valem sempre.
 */
const prohibitionOf = (p) => ({
  ...p, key: KEY[p.code], defaultTerms: FINANCEIRA_SETTING_DEFAULTS[KEY[p.code]],
  ...(p.code === 'PAGAR' ? { enabled: async (env) => !(await paymentProposalAllowed(env.tenant, env.transaction)) } : {}),
});

/** Proposta criada para o run: o aviso padrão da D020 ganha a frase da NAY Financeira ("Preparei uma proposta para aprovação humana"). */
const awaitingDecorator = (answer, info) => (info && info.awaiting ? `Preparei uma proposta para aprovação humana. ${answer}` : answer);

function registerNayFinanceira() {
  registerAgentScope({
    code: policy.CODE,
    outOfScopeMessage: policy.OUT_OF_SCOPE_MESSAGE,
    scopeTermsKey: K.scopeTerms,
    scopeTermsDefault: FINANCEIRA_SETTING_DEFAULTS[K.scopeTerms],
    prohibitions: policy.PROHIBITIONS.map(prohibitionOf),
    decorate: awaitingDecorator,
  });
  wireScopeGuard();
  registerFinanceiraGates();
  for (const [task, resolver] of Object.entries(RESOLVERS)) ruleResolvers.register(task, resolver);
  registerFinanceiraNumbers();
}

module.exports = { ...policy, GOLDEN_CASES: CASES, RULE_TASKS: RESOLVERS, FINANCEIRA_SETTING_DEFAULTS, FINANCEIRA_SETTINGS_SCHEMA, registerNayFinanceira };
