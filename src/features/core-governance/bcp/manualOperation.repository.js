'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.manual_operations (M9-D831). A RLS isola pela empresa da sessão; o filtro por company_id vale de qualquer forma. */
const COLUMNS = `o.id, o.group_id AS "groupId", o.company_id AS "companyId", o.manual_reference AS "manualReference", o.sector, o.occurred_at AS "occurredAt",
  o.recorded_at AS "recordedAt", o.actor_user_id AS "actorUserId", o.evidence_file_id AS "evidenceFileId", o.intended_action AS "intendedAction", o.form_type AS "formType",
  o.payload, o.correlation_ref AS "correlationRef", o.validation_errors AS "validationErrors", o.last_error AS "lastError", o.last_error_at AS "lastErrorAt", o.status,
  o.import_command_ref AS "importCommandRef", o.reject_reason AS "rejectReason", o.updated_at AS "updatedAt"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const one = async (sql, replacements, transaction) => (await select(sql, replacements, transaction))[0] || null;

/** Grava a operação; uma referência já usada na empresa não grava nada (ON CONFLICT DO NOTHING, sem abortar a transação) e devolve null. */
function insertOperation(op, transaction) {
  return one(
    `INSERT INTO governance.manual_operations AS o (group_id, company_id, manual_reference, sector, occurred_at, actor_user_id, evidence_file_id, intended_action, form_type,
       payload, correlation_ref, validation_errors)
     VALUES (:groupId, :companyId, :manualReference, :sector, :occurredAt, :actorUserId, :evidenceFileId, :intendedAction, :formType,
       CAST(:payload AS jsonb), :correlationRef, CAST(:validationErrors AS jsonb))
     ON CONFLICT (company_id, manual_reference) DO NOTHING RETURNING ${COLUMNS}`,
    { ...op, payload: JSON.stringify(op.payload), validationErrors: JSON.stringify(op.validationErrors) }, transaction
  );
}

const findById = (companyId, id, transaction, { lock = false } = {}) => one(
  `SELECT ${COLUMNS} FROM governance.manual_operations o WHERE o.company_id = :companyId AND o.id = :id${lock ? ' FOR UPDATE' : ''}`, { companyId, id }, transaction
);

function updatePayload(companyId, id, payload, validationErrors, transaction) {
  return one(
    `UPDATE governance.manual_operations AS o SET payload = CAST(:payload AS jsonb), validation_errors = CAST(:validationErrors AS jsonb), updated_at = now()
      WHERE o.company_id = :companyId AND o.id = :id RETURNING ${COLUMNS}`,
    { companyId, id, payload: JSON.stringify(payload), validationErrors: JSON.stringify(validationErrors) }, transaction
  );
}

/** Lista as operações dos setores permitidos (já filtrados pelo chamador), com os filtros opcionais. */
async function listOperations(companyId, { sectors, status, sector, correlationRef, limit, offset }, transaction) {
  const where = `o.company_id = :companyId AND o.sector IN (:sectors)
        AND (CAST(:status AS text) IS NULL OR o.status = :status) AND (CAST(:sector AS text) IS NULL OR o.sector = :sector)
        AND (CAST(:correlationRef AS uuid) IS NULL OR o.correlation_ref = :correlationRef)`;
  const replacements = { companyId, sectors, status: status || null, sector: sector || null, correlationRef: correlationRef || null };
  const [{ total }] = await select(`SELECT count(*)::int AS total FROM governance.manual_operations o WHERE ${where}`, replacements, transaction);
  const rows = await select(`SELECT ${COLUMNS} FROM governance.manual_operations o WHERE ${where} ORDER BY o.recorded_at DESC, o.manual_reference LIMIT :limit OFFSET :offset`, { ...replacements, limit, offset }, transaction);
  return { rows, total };
}

/** A evidência existe na empresa (a RLS de people.files isola; o filtro explícito vale também) e está ativa? */
async function evidenceExists(companyId, fileId, transaction) {
  return Boolean(await one('SELECT f.id FROM people.files f WHERE f.id = :fileId AND f.company_id = :companyId AND f.deleted_at IS NULL', { companyId, fileId }, transaction));
}

module.exports = { insertOperation, findById, updatePayload, listOperations, evidenceExists };
