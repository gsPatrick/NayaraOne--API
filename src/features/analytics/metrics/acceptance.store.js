'use strict';

/**
 * M9-D708 — gravação e leitura de analytics.metric_acceptance. A escrita liga o marcador do escritor do BI (RLS) na transação do chamador.
 * Uma linha por (empresa, métrica, versão): a reconciliação cria ou atualiza (e devolve a linha a PENDING); a nova versão da métrica cria a sua linha PENDING;
 * a decisão trava a linha (FOR UPDATE) e a fecha.
 */
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { enableAnalyticsWriter } = require('../metricStore.service');

const COLUMNS = `id, company_id AS "companyId", metric_code AS "metricCode", metric_version AS "metricVersion", owner_user_id AS "ownerUserId", reference_report AS "referenceReport",
  reference_value AS "referenceValue", bi_value AS "biValue", difference, tolerance, evidence_file_id AS "evidenceFileId", status, accepted_by AS "acceptedBy",
  accepted_at AS "acceptedAt", comment`;

async function find(companyId, metricCode, version, transaction, { lock = false } = {}) {
  if (lock) await enableAnalyticsWriter(transaction); // SELECT ... FOR UPDATE também passa pela política de UPDATE (escritor do BI)
  const rows = await sequelize.query(
    `SELECT ${COLUMNS} FROM analytics.metric_acceptance WHERE company_id = :companyId AND metric_code = :metricCode AND metric_version = :version ${lock ? 'FOR UPDATE' : ''}`,
    { type: QueryTypes.SELECT, replacements: { companyId, metricCode, version }, transaction }
  );
  return rows[0] || null;
}

/** Cria ou atualiza a linha da versão com o resultado da reconciliação e a devolve a PENDING (zera a decisão anterior da mesma versão). */
async function upsertReconciliation(ctx, row, transaction) {
  await enableAnalyticsWriter(transaction);
  const rows = await sequelize.query(
    `INSERT INTO analytics.metric_acceptance (company_id, group_id, metric_code, metric_version, owner_user_id, reference_report, reference_value, bi_value, difference, tolerance, comment, status, reconciled_at)
     VALUES (:companyId, :groupId, :metricCode, :version, :ownerUserId, :referenceReport, :referenceValue, :biValue, :difference, :tolerance, :comment, 'PENDING', now())
     ON CONFLICT (company_id, metric_code, metric_version) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, reference_report = EXCLUDED.reference_report,
       reference_value = EXCLUDED.reference_value, bi_value = EXCLUDED.bi_value, difference = EXCLUDED.difference, tolerance = EXCLUDED.tolerance, comment = EXCLUDED.comment,
       status = 'PENDING', accepted_by = NULL, accepted_at = NULL, evidence_file_id = NULL, reconciled_at = now(), updated_at = now()
     RETURNING ${COLUMNS}`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: ctx.companyId, groupId: ctx.groupId, metricCode: row.metricCode, version: row.version, ownerUserId: row.ownerUserId || null,
      referenceReport: row.referenceReport, referenceValue: row.referenceValue, biValue: row.biValue, difference: row.difference, tolerance: row.tolerance, comment: row.comment || null } }
  );
  return rows[0];
}

/** Linha PENDING da versão nova da métrica (sem valores); não mexe numa linha que já exista. */
async function insertPending(ctx, metricCode, version, transaction) {
  await enableAnalyticsWriter(transaction);
  await sequelize.query(
    `INSERT INTO analytics.metric_acceptance (company_id, group_id, metric_code, metric_version, status, comment)
     VALUES (:companyId, :groupId, :metricCode, :version, 'PENDING', 'Nova versão da métrica: o aceite anterior não vale; reconcilie e peça o aceite do responsável.')
     ON CONFLICT (company_id, metric_code, metric_version) DO NOTHING`,
    { transaction, replacements: { companyId: ctx.companyId, groupId: ctx.groupId, metricCode, version } }
  );
}

async function close(ctx, { id, status, userId, evidenceFileId, comment }, transaction) {
  await enableAnalyticsWriter(transaction);
  const rows = await sequelize.query(
    `UPDATE analytics.metric_acceptance SET status = :status, accepted_by = :userId, accepted_at = now(), evidence_file_id = :evidenceFileId,
            comment = COALESCE(:comment, comment), updated_at = now()
      WHERE id = :id AND company_id = :companyId RETURNING ${COLUMNS}`,
    { type: QueryTypes.SELECT, transaction, replacements: { id, status, userId, evidenceFileId, comment: comment || null, companyId: ctx.companyId } }
  );
  return rows[0];
}

module.exports = { find, upsertReconciliation, insertPending, close };
