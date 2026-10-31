'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Pedidos DOWNLOAD e PRINT em governance.export_jobs (M9-D920). A RLS isola pela empresa da sessão; o filtro por company_id vale de qualquer forma. */
const COLUMNS = `id, kind, action, resource_type AS "resourceType", resource_ref AS "resourceRef", classification, purpose, justification, estimated_rows AS "estimatedRows", status,
  obligations, expires_at AS "expiresAt", actor_user_id AS "actorUserId", watermark, download_count AS "downloadCount", error_code AS "errorCode", group_id AS "groupId", company_id AS "companyId"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const one = async (sql, replacements, transaction) => (await select(sql, replacements, transaction))[0] || null;

const findGrant = (companyId, id, kind, transaction) => one(
  `SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND id = :id AND kind = :kind`, { companyId, id, kind }, transaction
);

/** Guarda no pedido aprovado o prazo do endereço, a marca d'água decidida e o que será entregue (ids dos arquivos ou o recurso a imprimir). */
const attachGrant = (companyId, id, grant, transaction) => one(
  `UPDATE governance.export_jobs SET expires_at = :expiresAt, watermark = :watermark, resource_ref = COALESCE(resource_ref, '{}'::jsonb) || CAST(:ref AS jsonb), updated_at = now()
   WHERE company_id = :companyId AND id = :id AND status = 'APPROVED' RETURNING ${COLUMNS}`,
  { companyId, id, expiresAt: grant.expiresAt, watermark: grant.watermark === true, ref: JSON.stringify(grant.resourceRef || {}) }, transaction
);

/** Usa o endereço UMA vez, de forma atômica: só leva quem encontra o pedido APPROVED, sem uso e dentro do prazo. */
const consume = (companyId, id, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'READY', download_count = download_count + 1, generated_at = now(), updated_at = now()
   WHERE company_id = :companyId AND id = :id AND status = 'APPROVED' AND download_count = 0 AND (expires_at IS NULL OR expires_at > now()) RETURNING ${COLUMNS}`,
  { companyId, id }, transaction
);

const markFailed = (companyId, id, code, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'FAILED', error_code = :code, updated_at = now() WHERE company_id = :companyId AND id = :id AND status IN ('APPROVED', 'READY') RETURNING ${COLUMNS}`,
  { companyId, id, code }, transaction
);

const markExpired = (companyId, id, transaction) => one(
  `UPDATE governance.export_jobs SET status = 'EXPIRED', expired_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id AND status = 'APPROVED' RETURNING ${COLUMNS}`,
  { companyId, id }, transaction
);

/** Pedidos de download e impressão aprovados que ninguém usou e cujo prazo passou: viram EXPIRED (o exportExpiryJob chama isto a cada passada). Devolve a quantidade. */
async function expireUnused(companyId, now, transaction) {
  const rows = await select(
    `UPDATE governance.export_jobs SET status = 'EXPIRED', expired_at = now(), updated_at = now()
     WHERE company_id = :companyId AND kind IN ('DOWNLOAD', 'PRINT') AND status = 'APPROVED' AND download_count = 0 AND expires_at IS NOT NULL AND expires_at < :now RETURNING id`,
    { companyId, now }, transaction
  );
  return rows.length;
}

module.exports = { findGrant, attachGrant, consume, markFailed, markExpired, expireUnused, COLUMNS };
