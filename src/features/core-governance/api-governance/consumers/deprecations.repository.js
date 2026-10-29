'use strict';

const { select } = require('./consumers.repository');

/** Acesso a governance.api_deprecations (M9-D841). */
const COLUMNS = `d.id, d.group_id AS "groupId", d.company_id AS "companyId", d.target, d.announced_at AS "announcedAt", d.sunset_at AS "sunsetAt", d.owner_user_id AS "ownerUserId",
  d.replacement, d.replacement_note AS "replacementNote", d.status, d.created_by AS "createdBy", d.created_at AS "createdAt"`;

async function insertDeprecation(row, transaction) {
  const rows = await select(
    `INSERT INTO governance.api_deprecations AS d (group_id, company_id, target, announced_at, sunset_at, owner_user_id, replacement, replacement_note, created_by)
     VALUES (:groupId, :companyId, :target, :announcedAt, :sunsetAt, :ownerUserId, :replacement, :replacementNote, :createdBy)
     ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`, row, transaction
  );
  return rows[0] || null;
}

const lockById = async (companyId, id, transaction) => (await select(
  `SELECT ${COLUMNS} FROM governance.api_deprecations d WHERE d.company_id = :companyId AND d.id = :id FOR UPDATE`, { companyId, id }, transaction
))[0] || null;

const setStatus = async (companyId, id, status, transaction) => (await select(
  `UPDATE governance.api_deprecations d SET status = :status, updated_at = now() WHERE d.company_id = :companyId AND d.id = :id RETURNING ${COLUMNS}`, { companyId, id, status }, transaction
))[0] || null;

/** Deprecações que valem na empresa (qualquer situação menos CANCELLED): base dos cabeçalhos, do 410 e da lista dos consumidores. */
const listActive = (companyId, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.api_deprecations d WHERE d.company_id = :companyId AND d.status <> 'CANCELLED' ORDER BY d.sunset_at, d.id`, { companyId }, transaction
);

/** Anunciadas, travadas para a avaliação diária (duas avaliações simultâneas não repetem o efeito). */
const lockAnnounced = (companyId, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.api_deprecations d WHERE d.company_id = :companyId AND d.status = 'ANNOUNCED' ORDER BY d.sunset_at, d.id FOR UPDATE SKIP LOCKED`, { companyId }, transaction
);

async function list({ companyId, status, limit, offset }, transaction) {
  const where = status ? 'AND d.status = :status' : '';
  const total = (await select(`SELECT count(*)::int AS n FROM governance.api_deprecations d WHERE d.company_id = :companyId ${where}`, { companyId, status }, transaction))[0].n;
  const items = await select(
    `SELECT ${COLUMNS} FROM governance.api_deprecations d WHERE d.company_id = :companyId ${where} ORDER BY d.sunset_at, d.id LIMIT :limit OFFSET :offset`, { companyId, status, limit, offset }, transaction
  );
  return { items, total };
}

/** Consumidores ATIVOS que usaram o alvo dentro da janela (api_consumer_usage). */
const activeConsumersOf = (companyId, target, activeDays, transaction) => select(
  `SELECT DISTINCT c.id, c.name, c.owner_user_id AS "ownerUserId" FROM governance.api_consumer_usage u JOIN governance.api_consumers c ON c.id = u.consumer_id
    WHERE u.company_id = :companyId AND u.target_key = :target AND c.status = 'ACTIVE' AND u.last_seen_at >= now() - make_interval(days => :activeDays) ORDER BY c.id`,
  { companyId, target, activeDays }, transaction
);

module.exports = { COLUMNS, insertDeprecation, lockById, setStatus, listActive, lockAnnounced, list, activeConsumersOf };
