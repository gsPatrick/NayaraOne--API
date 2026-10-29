'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.export_jobs no fluxo de arquivo (M9-D822). A RLS isola pela empresa da sessão; o filtro por company_id vale de qualquer forma. */
const COLUMNS = `id, kind, action, resource_type AS "resourceType", classification, purpose, justification, estimated_rows AS "estimatedRows", status, block_reason AS "blockReason",
  obligations, expires_at AS "expiresAt", actor_user_id AS "actorUserId", idempotency_key AS "idempotencyKey", requested_at AS "requestedAt", decided_at AS "decidedAt",
  format, export_filter AS "filter", export_columns AS "columns", watermark, file_id AS "fileId", file_name AS "fileName", file_sha256 AS "fileSha256", row_count AS "rowCount",
  generated_at AS "generatedAt", expired_at AS "expiredAt", error_code AS "errorCode", download_count AS "downloadCount", group_id AS "groupId", company_id AS "companyId"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const one = async (sql, replacements, transaction) => (await select(sql, replacements, transaction))[0] || null;

const findById = (companyId, id, transaction) => one(`SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND id = :id AND kind = 'EXPORT' AND format IS NOT NULL`, { companyId, id }, transaction);
const findByKey = (companyId, key, transaction) => one(`SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND idempotency_key = :key`, { companyId, key }, transaction);
const findByIdForUpdate = (companyId, id, transaction) => one(`SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND id = :id FOR UPDATE`, { companyId, id }, transaction);

/** Guarda o que o pedido tem de arquivo (formato, filtro, colunas, marca d'água) no pedido que o guard acabou de decidir (aprovado ou bloqueado). */
async function attachRequest(companyId, id, body, transaction) {
  return one(
    `UPDATE governance.export_jobs SET format = :format, export_filter = CAST(:filter AS jsonb), export_columns = CAST(:columns AS jsonb), watermark = :watermark, updated_at = now()
     WHERE company_id = :companyId AND id = :id AND status IN ('APPROVED', 'BLOCKED') AND format IS NULL RETURNING ${COLUMNS}`,
    { companyId, id, format: body.format, filter: JSON.stringify(body.filter), columns: JSON.stringify(body.columns), watermark: body.watermark },
    transaction
  );
}

/** APPROVED -> GENERATING de forma atômica: só um gerador leva o pedido. */
const claim = (companyId, id, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'GENERATING', updated_at = now() WHERE company_id = :companyId AND id = :id AND status = 'APPROVED' AND format IS NOT NULL RETURNING ${COLUMNS}`,
  { companyId, id }, transaction
);

const markReady = (companyId, id, file, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'READY', file_id = :fileId, file_name = :fileName, file_sha256 = :sha, row_count = :rowCount, generated_at = now(), error_code = NULL, updated_at = now()
   WHERE company_id = :companyId AND id = :id AND status = 'GENERATING' RETURNING ${COLUMNS}`,
  { companyId, id, fileId: file.id, fileName: file.fileName, sha: file.sha256, rowCount: file.rowCount }, transaction
);

const markFailed = (companyId, id, errorCode, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'FAILED', error_code = :errorCode, file_id = NULL, updated_at = now() WHERE company_id = :companyId AND id = :id AND status IN ('APPROVED', 'GENERATING') RETURNING ${COLUMNS}`,
  { companyId, id, errorCode: String(errorCode).slice(0, 60) }, transaction
);

const countDownload = (companyId, id, transaction) => one(
  'UPDATE governance.export_jobs SET download_count = download_count + 1, updated_at = now() WHERE company_id = :companyId AND id = :id RETURNING download_count AS "downloadCount"', { companyId, id }, transaction
);

const listExpired = (companyId, now, limit, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND kind = 'EXPORT' AND status = 'READY' AND expires_at < :now ORDER BY expires_at LIMIT :limit FOR UPDATE SKIP LOCKED`,
  { companyId, now, limit }, transaction
);

const markExpired = (companyId, id, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'EXPIRED', file_id = NULL, expired_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id AND status = 'READY' RETURNING ${COLUMNS}`, { companyId, id }, transaction
);

const listStale = (companyId, before, limit, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND kind = 'EXPORT' AND status = 'GENERATING' AND updated_at < :before ORDER BY updated_at LIMIT :limit FOR UPDATE SKIP LOCKED`,
  { companyId, before, limit }, transaction
);

const listApproved = (companyId, limit, transaction) => select(
  `SELECT id FROM governance.export_jobs WHERE company_id = :companyId AND kind = 'EXPORT' AND status = 'APPROVED' AND format IS NOT NULL ORDER BY decided_at LIMIT :limit`, { companyId, limit }, transaction
);

/** Quantos arquivos a empresa tem ligados a pedidos (usado pelos testes e pela leitura do estado). */
const countByStatus = (companyId, transaction) => select("SELECT status, count(*)::int AS total FROM governance.export_jobs WHERE company_id = :companyId AND kind = 'EXPORT' GROUP BY status", { companyId }, transaction);

module.exports = { findById, findByKey, findByIdForUpdate, attachRequest, claim, markReady, markFailed, countDownload, listExpired, markExpired, listStale, listApproved, countByStatus, COLUMNS };
