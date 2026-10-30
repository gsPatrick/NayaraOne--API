'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const listPolicies = (tenant, transaction) => q(
  `SELECT p.*, b.environment, b.domain FROM governance.degradation_policies p JOIN governance.budgets b ON b.id = p.budget_id
    WHERE p.company_id = :companyId ORDER BY b.environment, b.domain`, transaction, { companyId: tenant.companyId }
);

async function findPolicyByBudget(tenant, budgetId, transaction, { lock = false } = {}) {
  const rows = await q(`SELECT * FROM governance.degradation_policies WHERE budget_id = :budgetId AND company_id = :companyId${lock ? ' FOR UPDATE' : ''}`, transaction, { budgetId, companyId: tenant.companyId });
  return rows[0] || null;
}

async function upsertPolicy(tenant, { budgetId, steps, enabled }, actorUserId, transaction) {
  const rows = await q(
    `INSERT INTO governance.degradation_policies (group_id, company_id, budget_id, steps, enabled, created_by, updated_by)
     VALUES (:groupId, :companyId, :budgetId, CAST(:steps AS jsonb), :enabled, :actor, :actor)
     ON CONFLICT (budget_id) DO UPDATE SET steps = EXCLUDED.steps, enabled = EXCLUDED.enabled, updated_by = :actor, updated_at = now()
     RETURNING *`,
    transaction, { groupId: tenant.groupId, companyId: tenant.companyId, budgetId, steps: JSON.stringify(steps), enabled, actor: actorUserId || null }
  );
  return rows[0];
}

/** Insere a ação; o passo já APPLIED no período (índice único parcial) devolve null. */
async function insertAction(tenant, a, transaction) {
  const rows = await q(
    `INSERT INTO governance.degradation_actions (group_id, company_id, budget_id, policy_id, step, threshold, period_start, applied_percent, trigger_event_id, previous_value, applied_at)
     VALUES (:groupId, :companyId, :budgetId, :policyId, :step, :threshold, :periodStart, :percent, :eventId, CAST(:previous AS jsonb), :now)
     ON CONFLICT (budget_id, period_start, step) WHERE status = 'APPLIED' DO NOTHING RETURNING *, period_start::text AS period_start`,
    transaction, { groupId: tenant.groupId, companyId: tenant.companyId, budgetId: a.budgetId, policyId: a.policyId, step: a.step, threshold: a.threshold, periodStart: a.periodStart, percent: a.percent, eventId: a.eventId || null, previous: JSON.stringify(a.previous || {}), now: a.now }
  );
  return rows[0] || null;
}

const listApplied = (tenant, transaction, { lock = false } = {}) => q(
  `SELECT *, period_start::text AS period_start FROM governance.degradation_actions WHERE company_id = :companyId AND status = 'APPLIED' ORDER BY applied_at, id${lock ? ' FOR UPDATE' : ''}`, transaction, { companyId: tenant.companyId }
);

const listAppliedByBudget = (tenant, budgetId, transaction) => q(
  "SELECT *, period_start::text AS period_start FROM governance.degradation_actions WHERE company_id = :companyId AND budget_id = :budgetId AND status = 'APPLIED'", transaction, { companyId: tenant.companyId, budgetId }
);

async function markReverted(tenant, id, reason, now, transaction) {
  const rows = await q(
    `UPDATE governance.degradation_actions SET status = 'REVERTED', reverted_at = :now, revert_reason = :reason, updated_at = now()
      WHERE id = :id AND company_id = :companyId AND status = 'APPLIED' RETURNING *, period_start::text AS period_start`,
    transaction, { id, companyId: tenant.companyId, reason, now }
  );
  return rows[0] || null;
}

const listRecent = (tenant, transaction, limit = 50) => q(
  `SELECT a.*, a.period_start::text AS period_start, b.environment, b.domain FROM governance.degradation_actions a JOIN governance.budgets b ON b.id = a.budget_id
    WHERE a.company_id = :companyId ORDER BY a.applied_at DESC, a.id LIMIT :limit`, transaction, { companyId: tenant.companyId, limit }
);

async function isStepApplied(tenant, step, transaction) {
  const rows = await q("SELECT 1 AS hit FROM governance.degradation_actions WHERE company_id = :companyId AND step = :step AND status = 'APPLIED' LIMIT 1", transaction, { companyId: tenant.companyId, step });
  return rows.length > 0;
}

module.exports = { listPolicies, findPolicyByBudget, upsertPolicy, insertAction, listApplied, listAppliedByBudget, markReverted, listRecent, isStepApplied };
