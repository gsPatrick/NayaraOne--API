'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.access_anomalies (M9-D824). A RLS isola pela empresa da sessão; o filtro explícito por company_id vale de qualquer forma. */
const COLUMNS = `id, user_id AS "userId", kind, status, window_minutes AS "windowMinutes", trigger_signals AS "triggerSignals", detected_at AS "detectedAt",
  restricted_until AS "restrictedUntil", mfa_forced_since AS "mfaForcedSince", mfa_forced_until AS "mfaForcedUntil", reviewed_by AS "reviewedBy",
  reviewed_at AS "reviewedAt", review_reason AS "reviewReason"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Abre a anomalia; devolve null se o usuário já tem uma ABERTA do mesmo tipo (índice único parcial; corrida resolvida pelo banco). */
async function insertOpen(tenant, row, transaction) {
  const rows = await select(
    `INSERT INTO governance.access_anomalies (group_id, company_id, user_id, kind, status, window_minutes, trigger_signals, detected_at, restricted_until, mfa_forced_since, mfa_forced_until)
     VALUES (:groupId, :companyId, :userId, :kind, 'OPEN', :windowMinutes, CAST(:triggerSignals AS jsonb), :detectedAt, :restrictedUntil, :mfaForcedSince, :mfaForcedUntil)
     ON CONFLICT (company_id, user_id, kind) WHERE status = 'OPEN' DO NOTHING RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, ...row, triggerSignals: JSON.stringify(row.triggerSignals) },
    transaction
  );
  return rows[0] || null;
}

const findById = async (companyId, id, transaction, { lock = false } = {}) => (await select(
  `SELECT ${COLUMNS} FROM governance.access_anomalies WHERE company_id = :companyId AND id = :id${lock ? ' FOR UPDATE' : ''}`, { companyId, id }, transaction
))[0] || null;

async function list(companyId, { status, userId, kind, limit, offset }, transaction) {
  const where = 'company_id = :companyId AND (CAST(:status AS varchar) IS NULL OR status = :status) AND (CAST(:userId AS uuid) IS NULL OR user_id = :userId) AND (CAST(:kind AS varchar) IS NULL OR kind = :kind)';
  const replacements = { companyId, status: status || null, userId: userId || null, kind: kind || null, limit, offset };
  const rows = await select(`SELECT ${COLUMNS} FROM governance.access_anomalies WHERE ${where} ORDER BY detected_at DESC, id LIMIT :limit OFFSET :offset`, replacements, transaction);
  const [{ total }] = await select(`SELECT count(*)::int AS total FROM governance.access_anomalies WHERE ${where}`, replacements, transaction);
  return { rows, total };
}

/** Grava a revisão; `restrictedUntil` e os dois campos de MFA vão juntos (nulos zeram a contribuição da anomalia). */
async function applyReview(companyId, id, review, transaction) {
  const rows = await select(
    `UPDATE governance.access_anomalies SET status = :status, reviewed_by = :reviewedBy, reviewed_at = :reviewedAt, review_reason = :reason, restricted_until = :restrictedUntil,
       mfa_forced_since = :mfaForcedSince, mfa_forced_until = :mfaForcedUntil, updated_at = now()
     WHERE company_id = :companyId AND id = :id RETURNING ${COLUMNS}`,
    { companyId, id, ...review },
    transaction
  );
  return rows[0];
}

/** Instante da última revisão humana do usuário naquele tipo: os sinais anteriores já foram julgados e não somam de novo. */
async function lastReviewedAt(companyId, userId, kind, transaction) {
  const rows = await select(
    'SELECT max(reviewed_at) AS "reviewedAt" FROM governance.access_anomalies WHERE company_id = :companyId AND user_id = :userId AND kind = :kind AND reviewed_at IS NOT NULL',
    { companyId, userId, kind }, transaction
  );
  return rows[0].reviewedAt ? new Date(rows[0].reviewedAt) : null;
}

module.exports = { lastReviewedAt, insertOpen, findById, list, applyReview };
