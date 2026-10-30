'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso SQL a ai.budgets e ai.budget_alerts (M9-D014; archGuard AI-004: SQL só em readmodels/). Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */
const select = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });

const COLUMNS = `id, group_id AS "groupId", company_id AS "companyId", agent_code AS "agentCode", model_class AS "modelClass", period,
  limit_amount::text AS "limitAmount", consumed_amount::text AS "consumedAmount", reserved_amount::text AS "reservedAmount",
  thresholds, action_at_100 AS "actionAt100", status, period_start AS "periodStart", period_end AS "periodEnd",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Orçamentos ATIVOS da empresa que contêm o escopo e o instante, travados (FOR UPDATE) em ordem de id para não haver deadlock. */
function lockApplicable(ctx, { agentCode, modelClass, at }, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM ai.budgets
      WHERE company_id = :companyId AND status = 'ACTIVE' AND period_start <= :at AND period_end > :at
        AND (agent_code IS NULL OR agent_code = :agentCode) AND (model_class IS NULL OR model_class = :modelClass)
      ORDER BY id FOR UPDATE`,
    { companyId: ctx.companyId, at, agentCode: agentCode || null, modelClass: modelClass || null }, transaction
  );
}

/** Os mesmos orçamentos de lockApplicable, só para leitura (sem travar): o roteador consulta o estado antes de escolher o caminho. */
function peekApplicable(ctx, { agentCode, at }, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM ai.budgets
      WHERE company_id = :companyId AND status = 'ACTIVE' AND period_start <= :at AND period_end > :at
        AND (agent_code IS NULL OR agent_code = :agentCode)
      ORDER BY id`,
    { companyId: ctx.companyId, at, agentCode: agentCode || null }, transaction
  );
}

/** Cria a linha do período atual copiando a mais recente de cada escopo anterior (limites, limiares, ação e status). */
async function copyPreviousPeriods(ctx, period, transaction) {
  const [, meta] = await run(
    `INSERT INTO ai.budgets (group_id, company_id, agent_code, model_class, period, limit_amount, thresholds, action_at_100, status, period_start, period_end, created_by, updated_by)
     SELECT DISTINCT ON (COALESCE(agent_code, ''), COALESCE(model_class, ''))
            group_id, company_id, agent_code, model_class, period, limit_amount, thresholds, action_at_100, status, :start, :end, NULL, NULL
       FROM ai.budgets WHERE company_id = :companyId AND period_start < :start
      ORDER BY COALESCE(agent_code, ''), COALESCE(model_class, ''), period_start DESC
     ON CONFLICT DO NOTHING`,
    { companyId: ctx.companyId, start: period.start, end: period.end }, transaction
  );
  // Para INSERT o Sequelize devolve a contagem de linhas como número; para outros comandos, o resultado do pg.
  return typeof meta === 'number' ? meta : (meta && meta.rowCount) || 0;
}

function insertBudget(ctx, b, transaction) {
  return select(
    `INSERT INTO ai.budgets (group_id, company_id, agent_code, model_class, period, limit_amount, thresholds, action_at_100, status, period_start, period_end, created_by, updated_by)
     VALUES (:groupId, :companyId, :agentCode, :modelClass, 'MONTH', :limit, :thresholds, :actionAt100, 'ACTIVE', :start, :end, :userId, :userId)
     RETURNING ${COLUMNS}`,
    {
      groupId: ctx.groupId, companyId: ctx.companyId, agentCode: b.agentCode || null, modelClass: b.modelClass || null, limit: b.limitAmount,
      thresholds: b.thresholds ? JSON.stringify(b.thresholds) : null, actionAt100: b.actionAt100 || null, start: b.period.start, end: b.period.end, userId: ctx.userId || null,
    }, transaction
  ).then((rows) => rows[0]);
}

async function findById(ctx, id, transaction, { lock = false } = {}) {
  const rows = await select(`SELECT ${COLUMNS} FROM ai.budgets WHERE id = :id AND company_id = :companyId ${lock ? 'FOR UPDATE' : ''}`, { id, companyId: ctx.companyId }, transaction);
  return rows[0] || null;
}

function updateBudget(ctx, id, set, transaction) {
  return select(
    `UPDATE ai.budgets SET limit_amount = :limit, thresholds = :thresholds, action_at_100 = :actionAt100, status = :status, updated_at = CURRENT_TIMESTAMP, updated_by = :userId
      WHERE id = :id AND company_id = :companyId RETURNING ${COLUMNS}`,
    {
      id, companyId: ctx.companyId, limit: set.limitAmount, thresholds: set.thresholds ? JSON.stringify(set.thresholds) : null, actionAt100: set.actionAt100 || null,
      status: set.status, userId: ctx.userId || null,
    }, transaction
  ).then((rows) => rows[0]);
}

function listForPeriod(ctx, at, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM ai.budgets WHERE company_id = :companyId AND period_start <= :at AND period_end > :at
      ORDER BY COALESCE(agent_code, ''), COALESCE(model_class, '')`,
    { companyId: ctx.companyId, at }, transaction
  );
}

/** Quais orçamentos (entre `ids`) NÃO comportam a reserva: consumido + reservado + estimativa passaria do limite. */
function overLimit(ids, estimate, transaction) {
  return select('SELECT id FROM ai.budgets WHERE id IN (:ids) AND consumed_amount + reserved_amount + :estimate > limit_amount', { ids, estimate }, transaction);
}

/** Soma a reserva; com `guard` só onde cabe (consumido + reservado + estimativa <= limite). Devolve os ids atualizados. */
async function addReservation(ids, estimate, guard, transaction) {
  const rows = await select(
    `UPDATE ai.budgets SET reserved_amount = reserved_amount + :estimate, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (:ids) ${guard ? 'AND consumed_amount + reserved_amount + :estimate <= limit_amount' : ''} RETURNING id`,
    { ids, estimate }, transaction
  );
  return rows.map((r) => r.id);
}

/** Trava (FOR UPDATE, em ordem de id) os orçamentos que seguraram a reserva, para o acerto e a rechecagem do limite serem atômicos. */
function lockByIds(ids, transaction) {
  return select('SELECT id FROM ai.budgets WHERE id IN (:ids) ORDER BY id FOR UPDATE', { ids }, transaction);
}

/** Troca a reserva pelo custo real em todos os orçamentos que a seguraram; devolve as linhas já atualizadas. */
function swapReservation(ids, estimate, actual, transaction) {
  return select(
    `UPDATE ai.budgets SET reserved_amount = GREATEST(reserved_amount - :estimate, 0), consumed_amount = consumed_amount + :actual, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (:ids) RETURNING ${COLUMNS}`,
    { ids, estimate, actual }, transaction
  );
}

async function insertAlert(budget, threshold, pct, transaction) {
  const rows = await select(
    `INSERT INTO ai.budget_alerts (group_id, company_id, budget_id, threshold, consumed_pct, consumed_amount, limit_amount, period_start)
     VALUES (:groupId, :companyId, :budgetId, :threshold, :pct, :consumed, :limit, :periodStart)
     ON CONFLICT (budget_id, threshold, period_start) DO NOTHING RETURNING id`,
    {
      groupId: budget.groupId, companyId: budget.companyId, budgetId: budget.id, threshold, pct, consumed: budget.consumedAmount, limit: budget.limitAmount, periodStart: budget.periodStart,
    }, transaction
  );
  return rows.length > 0;
}

function listAlerts(ctx, budgetIds, transaction) {
  if (!budgetIds.length) return Promise.resolve([]);
  return select(
    `SELECT budget_id AS "budgetId", threshold, consumed_pct::text AS "consumedPct", consumed_amount::text AS "consumedAmount", created_at AS "createdAt"
       FROM ai.budget_alerts WHERE company_id = :companyId AND budget_id IN (:ids) ORDER BY threshold`,
    { companyId: ctx.companyId, ids: budgetIds }, transaction
  );
}

/** Quem tem a permissão na empresa (vínculo ativo -> papel -> permissão), para avisar. */
async function usersWithPermission(ctx, code, transaction) {
  const rows = await select(
    `SELECT DISTINCT m.user_id AS "userId" FROM core.user_memberships m
       JOIN core.role_permissions rp ON rp.role_id = m.role_id
       JOIN core.permissions p ON p.id = rp.permission_id
      WHERE m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND p.code = :code`,
    { companyId: ctx.companyId, code }, transaction
  );
  return rows.map((r) => r.userId);
}

module.exports = {
  lockApplicable, peekApplicable, copyPreviousPeriods, insertBudget, findById, updateBudget, listForPeriod, overLimit, addReservation, lockByIds, swapReservation,
  insertAlert, listAlerts, usersWithPermission,
};
