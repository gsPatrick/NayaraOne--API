'use strict';

const { OutboxEvent } = require('../../../../models');
const { consumptionOf } = require('../budgets/budget.consumption');
const budgetRepo = require('../budgets/budget.repository');
const { bounds, monthKeyOf } = require('../budgets/budget.period');
const { EVENT_THRESHOLD, REVERT_REASONS } = require('./degradation.constants');
const { readDegradationParams } = require('./degradation.params');
const { applyStep, revertAction } = require('./degradation.apply');
const logHold = require('./log.hold');
const repo = require('./degradation.repository');

/**
 * Maior limiar já anunciado pelo evento finops.budget.threshold (M9-D861) para o orçamento no período, com o id do evento. É assim que a política CONSOME o
 * evento: o passo só é elegível se o limiar dele já foi publicado e o consumo atual ainda o sustenta.
 */
async function reachedByEvents(tenant, budgetId, periodStart, transaction) {
  const events = await OutboxEvent.findAll({ where: { eventType: EVENT_THRESHOLD, aggregateId: budgetId, companyId: tenant.companyId }, transaction });
  let best = { threshold: 0, eventId: null };
  for (const event of events) {
    const payload = event.payloadJson || {};
    if (payload.periodStart === periodStart && Number(payload.threshold) > best.threshold) best = { threshold: Number(payload.threshold), eventId: event.id };
  }
  return best;
}

/** Desfaz o que deve ser desfeito: novo período, política que não tem mais o passo (ou desligada), consumo abaixo do limiar ou degradação desligada pelo administrador. */
async function revertDue(tenant, params, periodStart, now, monthKey, transaction) {
  const reverted = [];
  for (const action of await repo.listApplied(tenant, transaction, { lock: true })) {
    let reason = null;
    const policy = await repo.findPolicyByBudget(tenant, action.budget_id, transaction);
    if (!params.enabled) reason = REVERT_REASONS.DISABLED;
    else if (action.period_start !== periodStart) reason = REVERT_REASONS.PERIOD_ENDED;
    else if (!policy || !policy.enabled || !policy.steps.some((s) => s.step === action.step)) reason = REVERT_REASONS.POLICY_CHANGED;
    else {
      const budget = await budgetRepo.find(tenant, action.budget_id, transaction);
      const c = await consumptionOf(tenant, budget, monthKey, now, transaction);
      if (c.percent < action.threshold) reason = REVERT_REASONS.BELOW_THRESHOLD;
    }
    if (reason && await revertAction(tenant, action, reason, now, transaction)) reverted.push({ step: action.step, budgetId: action.budget_id, reason });
  }
  return reverted;
}

/** Aplica no máximo UM passo por orçamento: o seguinte da política, na ordem, se o limiar dele foi anunciado pelo evento e o consumo atual o sustenta. */
async function applyNext(tenant, params, periodStart, monthKey, now, transaction) {
  const applied = [];
  for (const policy of await repo.listPolicies(tenant, transaction)) {
    if (!policy.enabled) continue;
    const budget = await budgetRepo.find(tenant, policy.budget_id, transaction, { lock: true });
    if (!budget) continue;
    const current = new Set((await repo.listAppliedByBudget(tenant, budget.id, transaction)).map((a) => a.step));
    const next = policy.steps.find((s) => !current.has(s.step));
    if (!next) continue;
    const c = await consumptionOf(tenant, budget, monthKey, now, transaction);
    const event = await reachedByEvents(tenant, budget.id, periodStart, transaction);
    if (c.final || c.percent < next.threshold || event.threshold < next.threshold) continue;
    const action = await applyStep(tenant, { budgetId: budget.id, policyId: policy.id, step: next.step, threshold: next.threshold, periodStart, percent: c.percent, eventId: event.eventId, now, params }, transaction);
    if (action) applied.push({ step: next.step, budgetId: budget.id, threshold: next.threshold, percent: c.percent });
  }
  return applied;
}

/** Liga ao processo o efeito que vive em memória (nível de log) conforme o banco: reaplica depois de reinício e solta o que não está mais aplicado. */
async function syncProcessEffects(tenant, params, transaction) {
  const active = (await repo.listApplied(tenant, transaction)).some((a) => a.step === 'REDUCE_LOG_LEVEL');
  if (active) logHold.hold(tenant.companyId, params.logLevel);
  else if (logHold.isHeld(tenant.companyId)) logHold.release(tenant.companyId);
}

/** Uma execução do finopsDegradationJob para a empresa (M9-D863 §3.3). Devolve { applied, reverted }. */
async function runDegradation(tenant, transaction, { now = new Date() } = {}) {
  const params = await readDegradationParams(tenant, transaction);
  const monthKey = monthKeyOf(now);
  const periodStart = bounds(monthKey).from;
  const reverted = await revertDue(tenant, params, periodStart, now, monthKey, transaction);
  const applied = params.enabled ? await applyNext(tenant, params, periodStart, monthKey, now, transaction) : [];
  await syncProcessEffects(tenant, params, transaction);
  return { applied, reverted };
}

module.exports = { runDegradation, syncProcessEffects };
