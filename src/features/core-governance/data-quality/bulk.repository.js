'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { LOT_STATUS } = require('./bulk.constants');
const { STATUS } = require('./merge.constants');

const q = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** O lote DONE desta chave na empresa (lote FAILED não conta: a chave pode ser repetida). */
async function findByKey(tenant, key, transaction) {
  const rows = await q("SELECT * FROM governance.bulk_changes WHERE company_id = :companyId AND idempotency_key = :key AND status <> 'FAILED'", { companyId: tenant.companyId, key }, transaction);
  return rows[0] || null;
}

/** Cria o lote (já DONE; a transação inteira desfaz se algo falhar). Devolve null se outra requisição já criou o lote desta chave. */
async function insertLot(tenant, actorUserId, parsed, key, transaction) {
  const rows = await q(
    `INSERT INTO governance.bulk_changes (group_id, company_id, entity_type, status, reason, filter_json, patch_json, idempotency_key, request_hash, created_by)
     VALUES (:groupId, :companyId, :entityType, :status, :reason, CAST(:filter AS jsonb), CAST(:patch AS jsonb), :key, :hash, :actorUserId)
     ON CONFLICT (company_id, idempotency_key) WHERE status <> 'FAILED' DO NOTHING RETURNING *`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, entityType: parsed.entityType, status: LOT_STATUS.DONE, reason: parsed.reason, filter: JSON.stringify(parsed.filter), patch: JSON.stringify(parsed.patch),
      key, hash: parsed.requestHash, actorUserId,
    },
    transaction
  );
  return rows[0] || null;
}

async function setAffected(lotId, count, transaction) {
  const rows = await q('UPDATE governance.bulk_changes SET affected_count = :count, updated_at = now() WHERE id = :lotId RETURNING *', { lotId, count }, transaction);
  return rows[0];
}

async function insertItem(tenant, lotId, item, transaction) {
  await q(
    `INSERT INTO governance.bulk_change_items (group_id, company_id, bulk_change_id, record_type, record_id, field_hashes, audit_log_id)
     VALUES (:groupId, :companyId, :lotId, :recordType, :recordId, CAST(:hashes AS jsonb), :auditLogId) RETURNING id`,
    { groupId: tenant.groupId, companyId: tenant.companyId, lotId, recordType: item.recordType, recordId: item.recordId, hashes: JSON.stringify(item.fieldHashes), auditLogId: item.auditLogId },
    transaction
  );
}

async function getLot(tenant, lotId, transaction) {
  const rows = await q('SELECT * FROM governance.bulk_changes WHERE id = :lotId AND company_id = :companyId', { lotId, companyId: tenant.companyId }, transaction);
  return rows[0] || null;
}

async function listLots(tenant, { limit, offset }, transaction) {
  const [{ total }] = await q('SELECT count(*)::int AS total FROM governance.bulk_changes WHERE company_id = :companyId', { companyId: tenant.companyId }, transaction);
  const rows = await q('SELECT * FROM governance.bulk_changes WHERE company_id = :companyId ORDER BY created_at DESC, id LIMIT :limit OFFSET :offset', { companyId: tenant.companyId, limit, offset }, transaction);
  return { rows, total };
}

async function listItems(lotId, { limit, offset }, transaction) {
  const [{ total }] = await q('SELECT count(*)::int AS total FROM governance.bulk_change_items WHERE bulk_change_id = :lotId', { lotId }, transaction);
  const rows = await q('SELECT * FROM governance.bulk_change_items WHERE bulk_change_id = :lotId ORDER BY created_at, id LIMIT :limit OFFSET :offset', { lotId, limit, offset }, transaction);
  return { rows, total };
}

/** Itens abertos da fila de revisão (D805) que citam os cadastros, travados FOR UPDATE: a troca de curador em massa muda o assigned_steward_id deles. */
function lockOpenReviewItems(tenant, entityType, ids, transaction) {
  return q(
    `SELECT * FROM governance.review_queue_items WHERE company_id = :companyId AND entity_type = :entityType AND status IN (:open)
        AND (primary_id IN (:ids) OR secondary_id IN (:ids)) ORDER BY id FOR UPDATE`, { companyId: tenant.companyId, entityType, ids, open: [STATUS.OPEN, STATUS.IN_REVIEW] }, transaction
  );
}

async function setReviewSteward(itemId, stewardId, transaction) {
  await sequelize.query('UPDATE governance.review_queue_items SET assigned_steward_id = :stewardId, updated_at = now() WHERE id = :itemId', { transaction, replacements: { itemId, stewardId } });
}

module.exports = { findByKey, insertLot, setAffected, insertItem, getLot, listLots, listItems, lockOpenReviewItems, setReviewSteward };
