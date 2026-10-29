'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso SQL a ai.release_gates (M9-D046; archGuard AI-004: SQL só em readmodels/). Sempre na transação do tenant: a RLS mostra as linhas da empresa e as do grupo. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const COLUMNS = `id, group_id AS "groupId", company_id AS "companyId", scope_type AS "scopeType", scope_ref AS "scopeRef", item, status,
  evidence_ref AS "evidenceRef", approved_by AS "approvedBy", approved_at AS "approvedAt", notes, registered_by AS "registeredBy",
  idempotency_key AS "idempotencyKey", created_at AS "createdAt", updated_at AS "updatedAt"`;

function list(filters, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM ai.release_gates
      WHERE (:item::text IS NULL OR item = :item) AND (:status::text IS NULL OR status = :status)
      ORDER BY item, scope_ref NULLS FIRST, company_id NULLS FIRST`,
    { item: filters.item || null, status: filters.status || null }, transaction
  );
}

async function findByKey({ companyId, item, scopeRef }, transaction, { lock = false } = {}) {
  const rows = await select(
    `SELECT ${COLUMNS} FROM ai.release_gates
      WHERE company_id IS NOT DISTINCT FROM :companyId AND item = :item AND COALESCE(scope_ref, '') = :scopeRef${lock ? ' FOR UPDATE' : ''}`,
    { companyId: companyId || null, item, scopeRef: scopeRef || '' }, transaction
  );
  return rows[0] || null;
}

async function findByIdempotency(groupId, key, transaction) {
  const rows = await select(`SELECT ${COLUMNS} FROM ai.release_gates WHERE group_id = :groupId AND idempotency_key = :key`, { groupId, key }, transaction);
  return rows[0] || null;
}

/** Cria a linha; se outra conexão criou a mesma chave antes, devolve null (o chamador relê travando e atualiza). */
async function insert(row, transaction) {
  const rows = await select(
    `INSERT INTO ai.release_gates (group_id, company_id, scope_type, scope_ref, item, status, evidence_ref, approved_by, approved_at, notes, registered_by, idempotency_key, created_by, updated_by)
     VALUES (:groupId, :companyId, :scopeType, :scopeRef, :item, :status, :evidenceRef, :approvedBy, :approvedAt, :notes, :registeredBy, :idempotencyKey, :registeredBy, :registeredBy)
     ON CONFLICT (group_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), item, COALESCE(scope_ref, '')) DO NOTHING
     RETURNING ${COLUMNS}`,
    row, transaction
  );
  return rows[0] || null;
}

async function update(id, patch, transaction) {
  const rows = await select(
    `UPDATE ai.release_gates SET status = :status, evidence_ref = :evidenceRef, approved_by = :approvedBy, approved_at = :approvedAt, notes = :notes,
            registered_by = :registeredBy, idempotency_key = COALESCE(:idempotencyKey, idempotency_key), updated_by = :registeredBy, updated_at = CURRENT_TIMESTAMP
      WHERE id = :id RETURNING ${COLUMNS}`,
    { ...patch, id }, transaction
  );
  return rows[0];
}

module.exports = { list, findByKey, findByIdempotency, insert, update };
