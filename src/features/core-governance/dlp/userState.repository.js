'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Acesso a governance.user_dlp_state (M9-D824): o que o IAM e o guard leem do usuário. `dlp_restricted_until` suspende EXPORT, SHARE e PRINT;
 * `mfa_step_up_forced_until` + `mfa_forced_since` fazem o MFA verificado antes da detecção deixar de valer. A RLS isola pela empresa da sessão.
 */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const findOne = async (companyId, userId, transaction) => (await select(
  `SELECT dlp_restricted_until AS "restrictedUntil", mfa_step_up_forced_until AS "mfaForcedUntil", mfa_forced_since AS "mfaForcedSince"
     FROM governance.user_dlp_state WHERE company_id = :companyId AND user_id = :userId`,
  { companyId, userId }, transaction
))[0] || null;

/** Recalcula o estado a partir das anomalias abertas ou confirmadas do usuário: o maior prazo de cada flag; sem nenhuma, tudo zerado. */
async function recompute(tenant, userId, transaction) {
  await sequelize.query(
    `INSERT INTO governance.user_dlp_state (group_id, company_id, user_id, dlp_restricted_until, mfa_step_up_forced_until, mfa_forced_since)
     SELECT :groupId, :companyId, :userId, max(restricted_until), max(mfa_forced_until), max(mfa_forced_since)
       FROM governance.access_anomalies WHERE company_id = :companyId AND user_id = :userId AND status IN ('OPEN', 'CONFIRMED')
     ON CONFLICT (company_id, user_id) DO UPDATE SET dlp_restricted_until = EXCLUDED.dlp_restricted_until, mfa_step_up_forced_until = EXCLUDED.mfa_step_up_forced_until,
       mfa_forced_since = EXCLUDED.mfa_forced_since, updated_at = now()`,
    { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, userId } }
  );
}

/**
 * Integração com o IAM (M9-D824 §3.3 item 2): o MFA verificado em `verifiedAt` ainda vale? Não vale se o usuário está sob MFA forçado (`mfa_step_up_forced_until` no
 * futuro) e a verificação é ANTERIOR à detecção (`mfa_forced_since`): a próxima ação sensível pede MFA novo. A empresa vem da sessão (RLS); a sessão não cai.
 */
async function isMfaVoided(userId, verifiedAt, now, transaction) {
  const rows = await select(
    `SELECT 1 AS voided FROM governance.user_dlp_state WHERE user_id = :userId AND mfa_step_up_forced_until > :now AND mfa_forced_since > :verifiedAt LIMIT 1`,
    { userId, verifiedAt, now }, transaction
  );
  return rows.length > 0;
}

module.exports = { findOne, recompute, isMfaVoided };
