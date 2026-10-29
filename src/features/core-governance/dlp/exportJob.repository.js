'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.export_jobs (M9-D821). A RLS isola pela empresa da sessão; o filtro explícito por company_id vale de qualquer forma. */
const COLUMNS = `id, kind, action, resource_type AS "resourceType", resource_ref AS "resourceRef", classification, purpose, justification, estimated_rows AS "estimatedRows",
  status, block_reason AS "blockReason", decision_trace AS "decisionTrace", obligations, expires_at AS "expiresAt", actor_user_id AS "actorUserId",
  idempotency_key AS "idempotencyKey", request_hash AS "requestHash", requested_at AS "requestedAt", decided_at AS "decidedAt"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Grava o pedido (REQUESTED) ANTES de qualquer avaliação. Devolve null se a Idempotency-Key já existe na empresa (corrida resolvida pelo índice único). */
async function insertRequested(tenant, req, transaction) {
  const rows = await select(
    `INSERT INTO governance.export_jobs (group_id, company_id, actor_user_id, kind, action, resource_type, resource_ref, purpose, justification, estimated_rows, status,
       correlation_id, idempotency_key, request_hash)
     VALUES (:groupId, :companyId, :actorUserId, :kind, :action, :resourceType, CAST(:resourceRef AS jsonb), :purpose, :justification, :estimatedRows, 'REQUESTED',
       :correlationId, :idempotencyKey, :requestHash)
     ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING ${COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: req.actorUserId, kind: req.kind, action: req.action, resourceType: req.resourceType,
      resourceRef: JSON.stringify({ resourceIds: req.resourceIds, query: req.query }), purpose: req.purpose, justification: req.justification, estimatedRows: req.estimatedRows,
      correlationId: req.correlationId, idempotencyKey: req.idempotencyKey, requestHash: req.requestHash,
    },
    transaction
  );
  return rows[0] || null;
}

const findByKey = async (companyId, key, transaction) => (await select(`SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND idempotency_key = :key`, { companyId, key }, transaction))[0] || null;
const findById = async (companyId, id, transaction) => (await select(`SELECT ${COLUMNS} FROM governance.export_jobs WHERE company_id = :companyId AND id = :id`, { companyId, id }, transaction))[0] || null;

/** Grava a decisão (APPROVED ou BLOCKED) com o rastro das etapas e as obrigações; a linha é travada antes (FOR UPDATE). */
async function finalize(companyId, id, result, transaction) {
  await select('SELECT id FROM governance.export_jobs WHERE company_id = :companyId AND id = :id FOR UPDATE', { companyId, id }, transaction);
  const blocked = result.decision === 'DENY';
  const rows = await select(
    `UPDATE governance.export_jobs SET classification = :classification, status = :status, block_reason = :blockReason, decision_trace = CAST(:trace AS jsonb),
       obligations = CAST(:obligations AS jsonb), expires_at = :expiresAt, decided_at = now(), updated_at = now()
     WHERE company_id = :companyId AND id = :id RETURNING ${COLUMNS}`,
    {
      companyId, id, classification: result.classification, status: blocked ? 'BLOCKED' : 'APPROVED', blockReason: blocked ? result.blockReason : null,
      trace: JSON.stringify(result.trace), obligations: JSON.stringify(result.obligations), expiresAt: result.obligations ? result.obligations.expiresAt : null,
    },
    transaction
  );
  return rows[0];
}

/** O pedido não some quando a avaliação quebra: fica FAILED com a causa no rastro. */
async function markFailed(companyId, id, error, transaction) {
  const rows = await select(
    `UPDATE governance.export_jobs SET status = 'FAILED', block_reason = NULL, decision_trace = CAST(:trace AS jsonb), decided_at = now(), updated_at = now()
     WHERE company_id = :companyId AND id = :id RETURNING ${COLUMNS}`,
    { companyId, id, trace: JSON.stringify([{ step: 'DECISION', result: 'FAILED', error: String((error && error.message) || error).slice(0, 500) }]) },
    transaction
  );
  return rows[0];
}

module.exports = { insertRequested, findByKey, findById, finalize, markFailed };
