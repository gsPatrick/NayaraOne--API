'use strict';

const repo = require('../readmodels/budgetSupport.readmodel');
const { monthPeriodOf } = require('./budgets.period');
const { CRITICALITY } = require('./budgets.constants');
const agentsRepo = require('../agents/agents.repository');

/** Especificidade: agente+modelo (3) > agente (2) > só modelo (1) > empresa (0). */
const specificity = (b) => (b.agentCode ? 2 : 0) + (b.modelClass ? 1 : 0);

/** O orçamento que governa a política: o mais específico entre os que contêm o escopo. O gasto conta em todos. */
function pickGoverning(budgets) {
  return budgets.reduce((best, b) => (!best || specificity(b) > specificity(best) ? b : best), null);
}

/** Garante a linha do mês de `at` para cada escopo que já teve orçamento (a virada de período só copia linhas existentes). */
function ensureCurrentPeriod(ctx, at, transaction) {
  return repo.copyPreviousPeriods(ctx, monthPeriodOf(at), transaction);
}

/** Criticidade única do agente: a da versão ativa (ai.agents.criticality). Sem versão ativa, a mais restritiva (NON_CRITICAL). */
async function agentCriticality(ctx, agentCode, transaction) {
  if (!agentCode) return CRITICALITY.NON_CRITICAL;
  const agent = await agentsRepo.findActiveFor(ctx, String(agentCode).toUpperCase(), transaction);
  return agent && agent.criticality === CRITICALITY.CRITICAL ? CRITICALITY.CRITICAL : CRITICALITY.NON_CRITICAL;
}

module.exports = { specificity, pickGoverning, ensureCurrentPeriod, agentCriticality };
