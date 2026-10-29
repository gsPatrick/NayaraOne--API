'use strict';

const { reserve, settle, release, spendWithBudget } = require('./budgets.gate');
const { listBudgets, createBudget, updateBudget } = require('./budgets.admin.service');
const { budgetPolicy } = require('./budgets.policy');
const { readBudgetParams } = require('./budgets.params');
const { BUDGET_SETTING_DEFAULTS, BUDGET_KEYS } = require('./budgets.settings');

/**
 * Serviço de orçamento da NAY (M9-D014): a porta única para o orquestrador e as rotas.
 *  - reserve / settle / release / spendWithBudget: reserva atômica antes de gastar e troca pelo custo real;
 *  - alertas em 50/75/90/100% do limite (padrão de ia.orcamento.limiares; o administrador troca os pontos), uma vez por limiar e período;
 *  - política de degradação (budgetPolicy) para agente não crítico e crítico;
 *  - sem orçamento resolvível: falha fechada, 403 AI_BUDGET_NOT_CONFIGURED; esgotado: 429 AI_BUDGET_EXHAUSTED.
 */
const DEFAULT_ALERT_THRESHOLDS = BUDGET_SETTING_DEFAULTS[BUDGET_KEYS.thresholds]; // "50,75,90,100"

module.exports = {
  reserve, settle, release, spendWithBudget, listBudgets, createBudget, updateBudget, budgetPolicy, readBudgetParams, DEFAULT_ALERT_THRESHOLDS,
};
