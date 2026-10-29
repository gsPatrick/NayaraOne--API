'use strict';

const lotView = (row) => ({
  id: row.id, entityType: row.entity_type, status: row.status, reason: row.reason, filter: row.filter_json, patch: row.patch_json, affectedCount: row.affected_count,
  idempotencyKey: row.idempotency_key, errorMessage: row.error_message, createdBy: row.created_by, createdAt: row.created_at,
});

/** Item do lote: só hashes dos valores; o claro está na auditoria individual (`auditLogId`). */
const itemView = (row) => ({ id: row.id, recordType: row.record_type, recordId: row.record_id, fieldHashes: row.field_hashes, auditLogId: row.audit_log_id, createdAt: row.created_at });

module.exports = { lotView, itemView };
