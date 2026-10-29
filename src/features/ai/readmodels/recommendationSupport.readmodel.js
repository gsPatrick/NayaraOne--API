'use strict';

const { sequelize } = require('../../../models');

/**
 * Consultas de apoio à recomendação da NAY (M9-D007). Único lugar de recommendations/ que fala SQL (archGuard AI-004).
 * Sempre dentro da transação do tenant (RLS FORCE continua valendo).
 */
async function acquireDedupLock(companyId, dedupKey, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.recommendations:${companyId}:${dedupKey}` }, transaction });
}

/** Quem solicitou o run (ai.ai_runs.user_id), ou null. */
async function runRequester(runId, companyId, transaction) {
  const [rows] = await sequelize.query('SELECT user_id FROM ai.ai_runs WHERE id = :id AND company_id = :company', { replacements: { id: runId, company: companyId }, transaction });
  return rows.length ? rows[0].user_id : undefined;
}

/** O usuário tem vínculo (membership) com a empresa? Usado para o destinatário (target_user_id). */
async function userBelongsToCompany(userId, companyId, transaction) {
  const [rows] = await sequelize.query(
    "SELECT 1 FROM core.user_memberships WHERE user_id = :user AND company_id = :company AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1", { replacements: { user: userId, company: companyId }, transaction }
  );
  return rows.length > 0;
}

module.exports = { acquireDedupLock, runRequester, userBelongsToCompany };
