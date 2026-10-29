'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O arquivo existe na empresa (a RLS já esconde os de outra; o filtro explícito vale de qualquer forma) e não foi apagado? */
async function companyFileExists(companyId, fileId, transaction) {
  if (typeof fileId !== 'string' || !UUID.test(fileId)) return false;
  const rows = await sequelize.query('SELECT id FROM people.files WHERE id = :fileId AND company_id = :companyId AND deleted_at IS NULL', {
    type: QueryTypes.SELECT, transaction, replacements: { fileId, companyId },
  });
  return rows.length > 0;
}

async function insertEvidence(row, transaction) {
  await sequelize.query(
    `INSERT INTO governance.field_change_evidence (group_id, company_id, entity_type, entity_id, field, value_before_hash, value_after_hash, source, evidence_file_id, note, actor_user_id, audit_log_id)
     VALUES (:groupId, :companyId, :entityType, :entityId, :field, :beforeHash, :afterHash, :source, :fileId, :note, :actorUserId, :auditLogId)`,
    { transaction, replacements: row }
  );
}

module.exports = { companyFileExists, insertEvidence };
