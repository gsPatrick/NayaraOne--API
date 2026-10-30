'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Insere o orçamento; escopo repetido (empresa + ambiente + domínio) devolve null (ON CONFLICT), sem estourar a transação. */
async function insert(tenant, b, actorUserId, transaction) {
  const rows = await q(
    `INSERT INTO governance.budgets (group_id, company_id, environment, domain, period, amount_cents, owner_user_id, created_by, updated_by)
     VALUES (:groupId, :companyId, :environment, :domain, 'MONTH', :amountCents, :ownerUserId, :actor, :actor)
     ON CONFLICT (company_id, environment, domain) DO NOTHING RETURNING *`,
    transaction, { groupId: tenant.groupId, companyId: tenant.companyId, environment: b.environment, domain: b.domain, amountCents: b.amountCents, ownerUserId: b.ownerUserId, actor: actorUserId || null }
  );
  return rows[0] || null;
}

/** Orçamento da empresa por id; `lock` faz FOR UPDATE (avaliação e alteração serializadas). */
async function find(tenant, id, transaction, { lock = false } = {}) {
  const rows = await q(`SELECT * FROM governance.budgets WHERE id = :id AND company_id = :companyId${lock ? ' FOR UPDATE' : ''}`, transaction, { id, companyId: tenant.companyId });
  return rows[0] || null;
}

const list = (tenant, transaction) => q('SELECT * FROM governance.budgets WHERE company_id = :companyId ORDER BY environment, domain', transaction, { companyId: tenant.companyId });

async function update(tenant, id, fields, actorUserId, transaction) {
  const rows = await q(
    `UPDATE governance.budgets SET amount_cents = :amountCents, owner_user_id = :ownerUserId, updated_by = :actor, updated_at = now()
      WHERE id = :id AND company_id = :companyId RETURNING *`,
    transaction, { id, companyId: tenant.companyId, amountCents: fields.amountCents, ownerUserId: fields.ownerUserId, actor: actorUserId || null }
  );
  return rows[0];
}

/** Reserva o limiar do período (UNIQUE): devolve a linha só para quem reservou primeiro. */
async function claimAlert(tenant, a, transaction) {
  const rows = await q(
    `INSERT INTO governance.budget_alerts (group_id, company_id, budget_id, period_start, threshold, percent, consumed_cents, budget_cents, series)
     VALUES (:groupId, :companyId, :budgetId, :periodStart, :threshold, :percent, :consumedCents, :budgetCents, :series)
     ON CONFLICT (budget_id, period_start, threshold) DO NOTHING RETURNING *`,
    transaction, { groupId: tenant.groupId, companyId: tenant.companyId, ...a }
  );
  return rows[0] || null;
}

const firedThresholds = async (budgetId, periodStart, transaction) => (
  await q('SELECT threshold FROM governance.budget_alerts WHERE budget_id = :budgetId AND period_start = :periodStart ORDER BY threshold', transaction, { budgetId, periodStart })
).map((r) => r.threshold);

const countBudgets = async (tenant, transaction) => (await q('SELECT count(*)::int AS n FROM governance.budgets WHERE company_id = :companyId', transaction, { companyId: tenant.companyId }))[0].n;

module.exports = { insert, find, list, update, claimAlert, firedThresholds, countBudgets };
