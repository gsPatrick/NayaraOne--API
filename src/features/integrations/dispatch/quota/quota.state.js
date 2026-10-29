'use strict';

const { sequelize } = require('../../../../models');
const { ensureCurrentRow } = require('../../health/healthStore');

/**
 * Última cota que o fornecedor informou para a connection (guardada na tentativa que a trouxe). Ainda vale se a renovação
 * (`resetsAt`) está no futuro; sem data de renovação, vale por `fallbackWaitS` a partir da tentativa. Devolve null se não há cota válida.
 */
async function readValidQuota(connectionId, now, fallbackWaitS, transaction) {
  const [rows] = await sequelize.query(
    `SELECT quota_limit, quota_remaining, quota_resets_at, started_at FROM "integration"."dispatch_attempts"
      WHERE connection_id = :id AND (quota_limit IS NOT NULL OR quota_remaining IS NOT NULL) ORDER BY started_at DESC, created_at DESC LIMIT 1`,
    { replacements: { id: connectionId }, transaction },
  );
  const q = rows[0];
  if (!q) return null;
  const resets = q.quota_resets_at ? new Date(q.quota_resets_at) : null;
  const vale = resets ? resets.getTime() > now.getTime() : new Date(q.started_at).getTime() + fallbackWaitS * 1000 > now.getTime();
  return vale ? { limit: q.quota_limit, remaining: q.quota_remaining, resetsAt: resets } : null;
}

/** Guarda a cota informada na tentativa e na linha ATUAL da saúde do fornecedor (quota_limit, quota_remaining, quota_resets_at). */
async function recordQuota(connection, attemptId, quota, now, transaction) {
  await sequelize.query(
    'UPDATE "integration"."dispatch_attempts" SET quota_limit = :l, quota_remaining = :r, quota_resets_at = :t WHERE id = :id',
    { replacements: { id: attemptId, l: quota.limit, r: quota.remaining, t: quota.resetsAt }, transaction },
  );
  await ensureCurrentRow(connection, now, transaction);
  await sequelize.query(
    `UPDATE "integration"."provider_health" SET quota_limit = COALESCE(:l, quota_limit), quota_remaining = :r, quota_resets_at = :t, updated_at = :now
      WHERE connection_id = :id AND window_minutes = 0`,
    { replacements: { id: connection.id, l: quota.limit, r: quota.remaining, t: quota.resetsAt, now }, transaction },
  );
}

module.exports = { readValidQuota, recordQuota };
