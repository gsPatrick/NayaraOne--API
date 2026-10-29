'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Acesso a governance.manual_operation_imports e governance.reconciliations (M9-D832). A RLS isola pela empresa; o filtro por company_id vale de qualquer forma. */
const IMPORT_COLUMNS = `i.id, i.manual_operation_id AS "manualOperationId", i.manual_reference AS "manualReference", i.intended_action AS "intendedAction", i.command_ref AS "commandRef",
  i.effect, i.result, i.imported_by AS "importedBy", i.imported_at AS "importedAt"`;
const RECON_COLUMNS = `r.id, r.manual_operation_id AS "manualOperationId", r.command_ref AS "commandRef", r.result, r.diff, r.reconciled_by AS "reconciledBy", r.reconciled_at AS "reconciledAt",
  r.decision, r.decided_by AS "decidedBy", r.decided_at AS "decidedAt", r.decision_note AS "decisionNote", r.created_at AS "createdAt"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const one = async (sql, replacements, transaction) => (await select(sql, replacements, transaction))[0] || null;
const json = (v) => JSON.stringify(v === undefined ? null : v);

const findImport = (companyId, manualReference, transaction) => one(
  `SELECT ${IMPORT_COLUMNS} FROM governance.manual_operation_imports i WHERE i.company_id = :companyId AND i.manual_reference = :manualReference`, { companyId, manualReference }, transaction
);

/** Grava a importação; a referência já importada na empresa não grava nada (ON CONFLICT DO NOTHING) e devolve null. */
const insertImport = (row, transaction) => one(
  `INSERT INTO governance.manual_operation_imports AS i (group_id, company_id, manual_operation_id, manual_reference, intended_action, command_ref, effect, result, imported_by)
   VALUES (:groupId, :companyId, :manualOperationId, :manualReference, :intendedAction, :commandRef, CAST(:effect AS jsonb), :result, :importedBy)
   ON CONFLICT (company_id, manual_reference) DO NOTHING RETURNING ${IMPORT_COLUMNS}`,
  { ...row, effect: json(row.effect) }, transaction
);

const insertReconciliation = (row, transaction) => one(
  `INSERT INTO governance.reconciliations AS r (group_id, company_id, manual_operation_id, command_ref, result, diff, reconciled_by, reconciled_at)
   VALUES (:groupId, :companyId, :manualOperationId, :commandRef, :result, CAST(:diff AS jsonb), :reconciledBy, :reconciledAt) RETURNING ${RECON_COLUMNS}`,
  { ...row, diff: json(row.diff) }, transaction
);

const findReconciliationByOperation = (companyId, manualOperationId, transaction) => one(
  `SELECT ${RECON_COLUMNS} FROM governance.reconciliations r WHERE r.company_id = :companyId AND r.manual_operation_id = :manualOperationId`, { companyId, manualOperationId }, transaction
);

const findReconciliation = (companyId, id, transaction, { lock = false } = {}) => one(
  `SELECT ${RECON_COLUMNS} FROM governance.reconciliations r WHERE r.company_id = :companyId AND r.id = :id${lock ? ' FOR UPDATE' : ''}`, { companyId, id }, transaction
);

const applyDecision = (companyId, id, { decision, decidedBy, note, reconciledBy }, transaction) => one(
  `UPDATE governance.reconciliations AS r SET decision = :decision, decided_by = :decidedBy, decided_at = now(), decision_note = :note,
     reconciled_by = :reconciledBy, reconciled_at = CASE WHEN :reconciledBy IS NULL THEN NULL ELSE now() END, updated_at = now()
   WHERE r.company_id = :companyId AND r.id = :id RETURNING ${RECON_COLUMNS}`,
  { companyId, id, decision, decidedBy, note, reconciledBy: reconciledBy || null }, transaction
);

/** Lista as reconciliações dos setores dados, com a operação junto (referência, setor, ação). `pending` = DIVERGENT ainda sem decisão. */
function listReconciliations(companyId, { sectors, result, pending, limit, offset }, transaction) {
  return select(
    `SELECT ${RECON_COLUMNS}, o.manual_reference AS "manualReference", o.sector, o.intended_action AS "intendedAction", o.status AS "operationStatus"
       FROM governance.reconciliations r JOIN governance.manual_operations o ON o.id = r.manual_operation_id
      WHERE r.company_id = :companyId AND o.sector IN (:sectors) AND (CAST(:result AS text) IS NULL OR r.result = :result)
        AND (CAST(:pending AS boolean) IS NULL OR (r.decision IS NULL AND r.result = 'DIVERGENT') = :pending)
      ORDER BY r.created_at DESC, o.manual_reference LIMIT :limit OFFSET :offset`,
    { companyId, sectors, result: result || null, pending: pending === undefined ? null : pending, limit, offset }, transaction
  );
}

/** Operações do pedido: por ids ou por correlation_ref, ordenadas por registro. */
function operationsByIds(companyId, ids, transaction) {
  return select('SELECT id, sector, manual_reference AS "manualReference" FROM governance.manual_operations WHERE company_id = :companyId AND id IN (:ids) ORDER BY recorded_at, manual_reference',
    { companyId, ids }, transaction);
}
function operationsByCorrelation(companyId, correlationRef, transaction) {
  return select('SELECT id, sector, manual_reference AS "manualReference" FROM governance.manual_operations WHERE company_id = :companyId AND correlation_ref = :correlationRef ORDER BY recorded_at, manual_reference',
    { companyId, correlationRef }, transaction);
}

/** Atualiza a operação depois do import ou da decisão (status, referência do comando, motivo da rejeição); zera o último erro. */
const setOperationState = (companyId, id, { status, importCommandRef, rejectReason }, transaction) => one(
  `UPDATE governance.manual_operations AS o SET status = :status, import_command_ref = COALESCE(:importCommandRef, o.import_command_ref), reject_reason = COALESCE(:rejectReason, o.reject_reason),
     last_error = NULL, last_error_at = NULL, updated_at = now() WHERE o.company_id = :companyId AND o.id = :id RETURNING o.id`,
  { companyId, id, status, importCommandRef: importCommandRef || null, rejectReason: rejectReason || null }, transaction
);

/** Falha de validação ou do comando: a operação segue RECORDED, com o último erro (destino único, M9-D831 §3.4). */
const setLastError = (companyId, id, message, transaction) => one(
  "UPDATE governance.manual_operations AS o SET last_error = :message, last_error_at = now(), updated_at = now() WHERE o.company_id = :companyId AND o.id = :id AND o.status = 'RECORDED' RETURNING o.id",
  { companyId, id, message: String(message).slice(0, 2000) }, transaction
);

module.exports = { findImport, insertImport, insertReconciliation, findReconciliationByOperation, findReconciliation, applyDecision, listReconciliations, operationsByIds, operationsByCorrelation, setOperationState, setLastError };
