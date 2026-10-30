'use strict';

const { STEPS } = require('../finops/degradation/degradation.constants');
const budgetRepo = require('../finops/budgets/budget.repository');
const degradationRepo = require('../finops/degradation/degradation.repository');
const { readFlagsParams } = require('./flags.params');
const { resolve } = require('./flags.resolve');
const service = require('./feature-flags.service');
const repo = require('./flags.repository');

/** Chave do registro para cada um dos cinco interruptores de degradação por custo (M9-D863/M9-D870): finops.degradation.<passo em minúsculas>. */
const switchKey = (step) => `finops.degradation.${String(step).toLowerCase()}`;

/**
 * Registra (se ainda não existir) e ajusta o interruptor de um passo de degradação como flag da empresa: escopo COMPANY, risco do parâmetro
 * governanca.flags.risco_interruptores_degradacao e responsável = responsável do orçamento que acionou o passo. É chamado pelo finopsDegradationJob na mesma transação da ação.
 */
async function setSwitch(tenant, step, active, budgetId, transaction) {
  if (!STEPS.includes(step)) return null;
  const key = switchKey(step);
  const existing = await repo.findBySlot(tenant, 'FLAG', key, 'COMPANY', tenant.companyId, transaction);
  if (existing) {
    if (existing.value === active) return existing;
    return service.updateEntry(tenant, { id: existing.id, value: active, reason: `Degradação por custo: passo ${step} ${active ? 'aplicado' : 'desfeito'}.` }, null, transaction);
  }
  const budget = budgetId ? await budgetRepo.find(tenant, budgetId, transaction) : null;
  if (!budget) return null;
  const params = await readFlagsParams(tenant, transaction);
  return service.createEntry(tenant, {
    key, kind: 'FLAG', value: active, ownerUserId: budget.owner_user_id, scope: 'COMPANY', scopeRef: tenant.companyId, risk: params.switchRisk,
    description: `Interruptor de degradação por custo: ${step}.`, reason: `Degradação por custo: passo ${step} ${active ? 'aplicado' : 'desfeito'}.`,
  }, null, transaction, { trustedOwner: true });
}

/** Depois de desfazer uma ação: o interruptor só desliga quando nenhum orçamento mantém o passo aplicado. */
async function syncAfterRevert(tenant, step, budgetId, transaction) {
  if (await degradationRepo.isStepApplied(tenant, step, transaction)) return null;
  return setSwitch(tenant, step, false, budgetId, transaction);
}

/** O passo está ativo? Lê a flag pelo `flags.resolve`; sem flag registrada ainda (empresa anterior à D870), vale a ação APPLIED da própria degradação. */
async function isSwitchActive(tenant, step, transaction) {
  const result = await resolve(tenant, switchKey(step), {}, transaction, { defaultValue: null });
  if (result.found) return result.value === true;
  return degradationRepo.isStepApplied(tenant, step, transaction);
}

module.exports = { switchKey, setSwitch, syncAfterRevert, isSwitchActive };
