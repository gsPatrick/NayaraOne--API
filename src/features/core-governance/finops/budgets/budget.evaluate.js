'use strict';

const repo = require('./budget.repository');
const { consumptionOf } = require('./budget.consumption');
const { fireReached } = require('./budget.alerts');
const { monthKeyOf } = require('./budget.period');

/**
 * Avalia UM orçamento num mês (M9-D861): trava a linha do orçamento (FOR UPDATE), calcula o consumo pela série certa e dispara os limiares atingidos ainda
 * não disparados. O percentual FINAL (mês fechado com fatura BILLED) é só calculado: não dispara nada. Devolve { consumption, fired }.
 */
async function evaluateBudget(tenant, budgetId, monthKey, transaction, { now = new Date() } = {}) {
  const budget = await repo.find(tenant, budgetId, transaction, { lock: true });
  if (!budget) return null;
  const consumption = await consumptionOf(tenant, budget, monthKey, now, transaction);
  const fired = consumption.final ? [] : await fireReached(tenant, budget, monthKey, consumption, transaction);
  return { budget, consumption, fired };
}

/** Avalia todos os orçamentos da empresa nos meses dados (padrão: o mês corrente). */
async function evaluateAll(tenant, transaction, { now = new Date(), months } = {}) {
  const keys = months && months.length ? [...new Set(months)].sort() : [monthKeyOf(now)];
  const results = [];
  for (const budget of await repo.list(tenant, transaction)) {
    for (const monthKey of keys) results.push(await evaluateBudget(tenant, budget.id, monthKey, transaction, { now }));
  }
  return results;
}

/** Gancho de cada gravação do ledger (a "avaliação a cada coleta"): reavalia os meses dos períodos tocados. Sem orçamento cadastrado, não faz nada. */
async function evaluateForPeriods(tenant, dates, transaction, { now = new Date() } = {}) {
  if (!dates.length || await repo.countBudgets(tenant, transaction) === 0) return [];
  return evaluateAll(tenant, transaction, { now, months: dates.map(monthKeyOf) });
}

module.exports = { evaluateBudget, evaluateAll, evaluateForPeriods };
