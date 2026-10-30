'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const listActivities = (tenant, transaction) => select(
  'SELECT code, title, sort_order AS "order", phase FROM governance.cutover_activities WHERE company_id = :companyId ORDER BY sort_order, code', { companyId: tenant.companyId }, transaction
);

const listEntries = (tenant, transaction, activityCode) => select(
  `SELECT activity_code AS "activityCode", user_id AS "userId", role, raci FROM governance.cutover_raci WHERE company_id = :companyId AND (:code::text IS NULL OR activity_code = :code)
   ORDER BY activity_code, raci, role NULLS FIRST, user_id`, { companyId: tenant.companyId, code: activityCode || null }, transaction
);

async function getActivity(tenant, code, transaction) {
  const [row] = await select('SELECT code, title, sort_order AS "order", phase FROM governance.cutover_activities WHERE company_id = :companyId AND code = :code FOR UPDATE', { companyId: tenant.companyId, code }, transaction);
  return row || null;
}

/** Quais dos ids são usuários com vínculo ativo na empresa (a validação do userId informado). */
async function existingUserIds(tenant, ids, transaction) {
  if (!ids.length) return new Set();
  const rows = await select("SELECT user_id FROM core.user_memberships WHERE company_id = :companyId AND status = 'ACTIVE' AND user_id IN (:ids)", { companyId: tenant.companyId, ids }, transaction);
  return new Set(rows.map((row) => row.user_id));
}

/** Troca a matriz de UMA atividade (apaga e regrava na transação do chamador: ou entra tudo ou nada). */
async function replaceEntries(tenant, code, entries, transaction) {
  await sequelize.query('DELETE FROM governance.cutover_raci WHERE company_id = :companyId AND activity_code = :code', { transaction, replacements: { companyId: tenant.companyId, code } });
  for (const entry of entries) {
    await sequelize.query(
      'INSERT INTO governance.cutover_raci (group_id, company_id, activity_code, user_id, role, raci) VALUES (:groupId, :companyId, :code, :userId, :role, :raci)',
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, code, userId: entry.userId || null, role: entry.role || null, raci: entry.raci } }
    );
  }
}

module.exports = { listActivities, listEntries, getActivity, existingUserIds, replaceEntries };
