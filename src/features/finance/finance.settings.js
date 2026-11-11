'use strict';

/**
 * Parâmetros do Financeiro que o administrador grava pela aba "Financeiro" de Configurações (PUT /settings/:key, permissão settings:update, a mesma das
 * demais chaves financeiras). Entram no SETTINGS_SCHEMA do serviço de parâmetros, que recusa com 400 SETTING_INVALID_VALUE qualquer valor fora do tipo ou da
 * faixa. O livro (Marco 4 §11 e §17) pede os controles e diz "configurável", mas não traz os números: os padrões ficam no código de quem lê cada chave
 * (FINANCE_SETTINGS_DEFAULTS repete esses valores para a tela e para os testes) e as faixas são limites de sanidade (as do catálogo de parâmetros, quando há).
 */
const KEYS = Object.freeze({
  manualReconciliationMinCount: 'finance.antifraud_manual_reconciliation_min_count',
  manualReconciliationWindowDays: 'finance.antifraud_manual_reconciliation_window_days',
  historyMultiplier: 'finance.antifraud_history_multiplier',
  newAccountThreshold: 'finance.antifraud_new_account_threshold',
  bankAccountCooldownHours: 'finance.bank_account_cooldown_hours',
  reconciliationAutoStrong: 'finance.reconciliation.auto_strong',
});

const FINANCE_SETTINGS_SCHEMA = Object.freeze({
  // §17 "Conciliação manual recorrente -> Alerta gerencial" (manualReconciliationAlert.js): quantas conciliações feitas à mão, dentro da janela, abrem o caso.
  [KEYS.manualReconciliationMinCount]: { type: 'integer', min: 1, max: 100 },
  [KEYS.manualReconciliationWindowDays]: { type: 'integer', min: 1, max: 365 },
  // FIN-005 (financeAntifraud.service.js): o QUANTO é ajustável aqui; o SE a regra está ativa é do Motor de Regras (evaluateRule('FIN-005'), fail-closed).
  [KEYS.historyMultiplier]: { type: 'number', min: 1, max: 100 },
  [KEYS.newAccountThreshold]: { type: 'number', min: 0, max: 999999999.99 },
  // FIN-TS-013 "Conta nova | Pagamento alto imediato | Controle extra": resfriamento, em horas, da conta bancária nova ou alterada (mesma regra FIN-005).
  [KEYS.bankAccountCooldownHours]: { type: 'integer', min: 0, max: 720 },
  // §11 "Forte: auto ou revisão conforme regra" (reconciliation.service.js autoReconcileSuggestion): desligado, a correspondência FORTE espera revisão humana.
  [KEYS.reconciliationAutoStrong]: { type: 'boolean' },
});

/** Padrão que vale enquanto a empresa não gravou nada (o mesmo que cada leitor usa como fallback). */
const FINANCE_SETTINGS_DEFAULTS = Object.freeze({
  [KEYS.manualReconciliationMinCount]: 3,
  [KEYS.manualReconciliationWindowDays]: 30,
  [KEYS.historyMultiplier]: 3,
  [KEYS.newAccountThreshold]: 10000,
  [KEYS.bankAccountCooldownHours]: 48,
  [KEYS.reconciliationAutoStrong]: false,
});

module.exports = { KEYS, FINANCE_SETTINGS_SCHEMA, FINANCE_SETTINGS_DEFAULTS };
