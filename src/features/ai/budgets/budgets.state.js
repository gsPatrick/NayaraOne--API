'use strict';

const repo = require('../readmodels/budgetSupport.readmodel');
const { readBudgetParams } = require('./budgets.params');
const { budgetPolicy } = require('./budgets.policy');
const { reaches } = require('./budgets.money');
const { pickGoverning, ensureCurrentPeriod, agentCriticality } = require('./budgets.resolve');

/**
 * Estado do orçamento para o roteador (M9-D012), SEM reservar nada: `{ configured, state, allowedPaths }`. Usa a mesma política da
 * reserva (budgets.policy), então o que o roteador enxerga é o que o portão de reserva vai aceitar. Sem orçamento ativo que contenha o
 * agente, `configured` é falso e só RULE passa (o modelo exige orçamento, 403 AI_BUDGET_NOT_CONFIGURED). A reserva atômica continua
 * sendo a palavra final (duas chamadas simultâneas nunca passam do limite).
 */
async function budgetState(ctx, { agentCode, criticality, at = new Date() } = {}, transaction) {
  const code = agentCode ? String(agentCode).toUpperCase() : null;
  const params = await readBudgetParams(ctx, transaction);
  await ensureCurrentPeriod(ctx, at, transaction);
  const budgets = await repo.peekApplicable(ctx, { agentCode: code, at }, transaction);
  if (!budgets.length) return { configured: false, state: 'NOT_CONFIGURED', allowedPaths: ['RULE'] };
  const governing = pickGoverning(budgets);
  const policy = budgetPolicy({
    reached: (pct) => reaches(governing.consumedAmount, governing.limitAmount, pct),
    criticality: criticality || (await agentCriticality(ctx, code, transaction)),
    actionAt100: governing.actionAt100 || params.actionAt100,
    degradeFrom: params.degradeFrom,
  });
  return { configured: true, state: policy.state, allowedPaths: policy.allowedPaths };
}

module.exports = { budgetState };
