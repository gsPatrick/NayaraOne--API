'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const budgetRepo = require('../budgets/budget.repository');
const { STEPS, AUDIT_POLICY_ENTITY, AUDIT_POLICY, REVERT_REASONS } = require('./degradation.constants');
const E = require('./degradation.errors');
const { readDegradationParams } = require('./degradation.params');
const { parsePolicy } = require('./policy.input');
const { revertAction } = require('./degradation.apply');
const repo = require('./degradation.repository');

const view = (p) => ({
  id: p.id, budgetId: p.budget_id, environment: p.environment, domain: p.domain, steps: p.steps, enabled: p.enabled, updatedAt: p.updated_at,
});

/** Políticas da empresa e a lista fechada de passos aceitos. */
async function listPolicies(tenant, transaction) {
  const rows = await repo.listPolicies(tenant, transaction);
  return { passosAceitos: STEPS, politicas: rows.map(view) };
}

/**
 * Cadastra ou altera a política de um orçamento (M9-D863 §3.2; exige governance:finops:manage na rota). Só os cinco passos de função, reversíveis e não críticos;
 * auditoria com antes e depois. Passo que saiu da política (ou política desligada) tem a ação em vigor desfeita na hora.
 */
async function putPolicy(tenant, body, actorUserId, transaction, { now = new Date() } = {}) {
  const degradation = await readDegradationParams(tenant, transaction);
  const input = parsePolicy(body, degradation);
  if (!(await budgetRepo.find(tenant, input.budgetId, transaction, { lock: true }))) throw E.budgetNotFound();
  const before = await repo.findPolicyByBudget(tenant, input.budgetId, transaction, { lock: true });
  const row = await repo.upsertPolicy(tenant, input, actorUserId, transaction);
  const kept = new Set(input.enabled ? input.steps.map((s) => s.step) : []);
  const reverted = [];
  for (const action of await repo.listAppliedByBudget(tenant, input.budgetId, transaction)) {
    if (kept.has(action.step)) continue;
    await revertAction(tenant, action, input.enabled ? REVERT_REASONS.POLICY_CHANGED : REVERT_REASONS.DISABLED, now, transaction);
    reverted.push(action.step);
  }
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: AUDIT_POLICY, entityType: AUDIT_POLICY_ENTITY, entityId: row.id,
    beforeJson: before ? { steps: before.steps, enabled: before.enabled } : null, afterJson: { steps: row.steps, enabled: row.enabled, revertedSteps: reverted },
    reason: 'Política de degradação por custo salva.',
  }, transaction);
  const budget = await budgetRepo.find(tenant, input.budgetId, transaction);
  return view({ ...row, environment: budget.environment, domain: budget.domain });
}

module.exports = { listPolicies, putPolicy };
