'use strict';

/**
 * Parâmetros da aprovação humana de ações da NAY (M9-D019), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv (conservador: nada que a NAY pede executa sem uma pessoa).
 * `ia.aprovacao.aprovador_distinto` é declarado e lido pela M9-D007 (recommendations); aqui só se reaproveita.
 */
const APPROVAL_KEYS = Object.freeze({
  directLowRiskWrite: 'ia.escrita_direta_baixo_risco',
  allowPaymentProposal: 'ia.financeira.permitir_proposta_pagamento',
});

const APPROVAL_SETTING_DEFAULTS = Object.freeze({
  [APPROVAL_KEYS.directLowRiskWrite]: false,
  [APPROVAL_KEYS.allowPaymentProposal]: false,
});

const APPROVAL_SETTINGS_SCHEMA = {
  [APPROVAL_KEYS.directLowRiskWrite]: { type: 'boolean' },
  [APPROVAL_KEYS.allowPaymentProposal]: { type: 'boolean' },
};

module.exports = { APPROVAL_KEYS, APPROVAL_SETTING_DEFAULTS, APPROVAL_SETTINGS_SCHEMA };
