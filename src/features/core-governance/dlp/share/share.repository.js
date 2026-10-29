'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.share_links (M9-D823). A RLS isola pela empresa da sessão; a resolução pelo hash usa a política de leitura por token (migration 823). */
const COLUMNS = `l.id, l.group_id AS "groupId", l.company_id AS "companyId", l.created_by AS "createdBy", l.resource_type AS "resourceType", l.resource_id AS "resourceId",
  l.recipient_label AS "recipientLabel", l.classification, l.expires_at AS "expiresAt", l.status, l.revoked_by AS "revokedBy", l.revoked_at AS "revokedAt",
  l.export_job_id AS "exportJobId", l.watermark, l.access_count AS "accessCount", l.last_accessed_at AS "lastAccessedAt", l.created_at AS "createdAt"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const one = async (sql, replacements, transaction) => (await select(sql, replacements, transaction))[0] || null;

async function insertLink(link, transaction) {
  return one(
    `INSERT INTO governance.share_links AS l (group_id, company_id, created_by, resource_type, resource_id, recipient_label, classification, token_hash, expires_at, export_job_id, watermark)
     VALUES (:groupId, :companyId, :createdBy, :resourceType, :resourceId, :recipientLabel, :classification, :tokenHash, :expiresAt, :exportJobId, :watermark) RETURNING ${COLUMNS}`,
    link, transaction
  );
}

const findById = (companyId, id, transaction, { lock = false } = {}) => one(`SELECT ${COLUMNS} FROM governance.share_links l WHERE l.company_id = :companyId AND l.id = :id${lock ? ' FOR UPDATE' : ''}`, { companyId, id }, transaction);
const findByJob = (companyId, exportJobId, transaction) => one(`SELECT ${COLUMNS} FROM governance.share_links l WHERE l.company_id = :companyId AND l.export_job_id = :exportJobId`, { companyId, exportJobId }, transaction);

async function listLinks(companyId, createdBy, { limit, offset }, transaction) {
  const where = 'l.company_id = :companyId AND (CAST(:createdBy AS uuid) IS NULL OR l.created_by = :createdBy)';
  const [{ total }] = await select(`SELECT count(*)::int AS total FROM governance.share_links l WHERE ${where}`, { companyId, createdBy }, transaction);
  const rows = await select(`SELECT ${COLUMNS} FROM governance.share_links l WHERE ${where} ORDER BY l.created_at DESC, l.id LIMIT :limit OFFSET :offset`, { companyId, createdBy, limit, offset }, transaction);
  return { rows, total };
}

/** Resolve a empresa pelo hash do token (a política share_token_lookup só deixa ver a linha cujo hash é o da transação). Devolve { id, groupId, companyId } ou null. */
async function resolveByHash(tokenHash, transaction) {
  await sequelize.query("SELECT set_config('app.share_token_hash', :hash, true)", { transaction, replacements: { hash: tokenHash } });
  return one('SELECT l.id, l.group_id AS "groupId", l.company_id AS "companyId" FROM governance.share_links l WHERE l.token_hash = :hash', { hash: tokenHash }, transaction);
}

/** O link só vale se ACTIVE e dentro do prazo (relógio do banco): a verificação é feita a cada acesso, sem cache. */
const findActiveForAccess = (companyId, id, transaction) => one(
  `SELECT ${COLUMNS} FROM governance.share_links l WHERE l.company_id = :companyId AND l.id = :id AND l.status = 'ACTIVE' AND l.expires_at > now() FOR UPDATE`, { companyId, id }, transaction
);

const recordAccess = (companyId, id, transaction) => sequelize.query(
  'UPDATE governance.share_links SET access_count = access_count + 1, last_accessed_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id', { transaction, replacements: { companyId, id } }
);

/** Revoga o link e o pedido na MESMA transação (M9-D823 §2b). */
async function markRevoked(companyId, id, userId, transaction) {
  const link = await one(
    `UPDATE governance.share_links AS l SET status = 'REVOKED', revoked_by = :userId, revoked_at = now(), updated_at = now() WHERE l.company_id = :companyId AND l.id = :id AND l.status = 'ACTIVE' RETURNING ${COLUMNS}`,
    { companyId, id, userId }, transaction
  );
  if (link) await sequelize.query("UPDATE governance.export_jobs SET status = 'REVOKED', updated_at = now() WHERE company_id = :companyId AND id = :jobId", { transaction, replacements: { companyId, jobId: link.exportJobId } });
  return link;
}

/** Marca como EXPIRED, nos dois, o que passou do prazo (o acesso já recusa por expires_at sem esperar este job). Devolve quantos links mudaram. */
async function markExpiredDue(companyId, transaction) {
  const rows = await select(
    `UPDATE governance.share_links AS l SET status = 'EXPIRED', updated_at = now() WHERE l.company_id = :companyId AND l.status = 'ACTIVE' AND l.expires_at <= now() RETURNING l.export_job_id AS "exportJobId"`, { companyId }, transaction
  );
  if (rows.length) {
    await sequelize.query("UPDATE governance.export_jobs SET status = 'EXPIRED', expired_at = now(), updated_at = now() WHERE company_id = :companyId AND id IN (:ids) AND status = 'APPROVED'", { transaction, replacements: { companyId, ids: rows.map((r) => r.exportJobId) } });
  }
  return rows.length;
}

/** Guarda no pedido (SHARE) o que o pedido pediu, para a repetição da mesma Idempotency-Key conferir o corpo; e o prazo do link como validade do pedido. */
const attachJob = (companyId, jobId, { request, expiresAt, status, errorCode }, transaction) => sequelize.query(
  `UPDATE governance.export_jobs SET export_filter = CAST(:request AS jsonb), expires_at = COALESCE(:expiresAt, expires_at), status = COALESCE(:status, status), error_code = COALESCE(:errorCode, error_code), updated_at = now()
   WHERE company_id = :companyId AND id = :jobId`,
  { transaction, replacements: { companyId, jobId, request: JSON.stringify(request), expiresAt: expiresAt || null, status: status || null, errorCode: errorCode || null } }
);

const findJobByKey = (companyId, key, transaction) => one(
  `SELECT id, status, block_reason AS "blockReason", purpose, justification, export_filter AS "request", actor_user_id AS "actorUserId", obligations, error_code AS "errorCode"
   FROM governance.export_jobs WHERE company_id = :companyId AND idempotency_key = :key`, { companyId, key }, transaction
);

module.exports = { insertLink, findById, findByJob, listLinks, resolveByHash, findActiveForAccess, recordAccess, markRevoked, markExpiredDue, attachJob, findJobByKey };
