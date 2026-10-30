'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const q = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = `id, schema_name, table_name, column_name, entity, classification, purpose, retention_policy_id, masking, mask_pattern, exportability, ai_allowed, owner_domain, source, version, updated_by, created_at, updated_at`;

function present(row) {
  return {
    id: row.id, schema: row.schema_name, table: row.table_name, column: row.column_name, entity: row.entity, classification: row.classification, purpose: row.purpose,
    retentionPolicyId: row.retention_policy_id, masking: row.masking, maskPattern: row.mask_pattern, exportability: row.exportability, aiAllowed: row.ai_allowed,
    ownerDomain: row.owner_domain, source: row.source, version: row.version, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const count = async (tenant, transaction) => Number((await q('SELECT count(*)::int AS n FROM governance.data_classification_registry WHERE company_id = :companyId', { companyId: tenant.companyId }, transaction))[0].n);

/** Insere (idempotente: ON CONFLICT DO NOTHING, nunca sobrescreve ajuste do steward) as linhas calculadas, em blocos. */
async function insertMissing(tenant, rows, transaction) {
  const SIZE = 1000;
  let created = 0;
  for (let i = 0; i < rows.length; i += SIZE) {
    // eslint-disable-next-line no-await-in-loop
    const inserted = await q(
      `INSERT INTO governance.data_classification_registry (group_id, company_id, schema_name, table_name, column_name, entity, classification, purpose, retention_policy_id, masking, mask_pattern, exportability, ai_allowed, owner_domain)
       SELECT :groupId, :companyId, r.schema_name, r.table_name, r.column_name, r.entity, r.classification, r.purpose, r.policy_id, r.masking, r.mask_pattern, r.exportability, r.ai_allowed, r.owner_domain
         FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(schema_name text, table_name text, column_name text, entity text, classification text, purpose text, policy_id uuid, masking text, mask_pattern text, exportability text, ai_allowed boolean, owner_domain text)
       ON CONFLICT (company_id, schema_name, table_name, column_name) DO NOTHING RETURNING id`,
      { groupId: tenant.groupId, companyId: tenant.companyId, rows: JSON.stringify(rows.slice(i, i + SIZE)) }, transaction
    );
    created += inserted.length;
  }
  return created;
}

async function find(tenant, { schema, table, column }, transaction, { forUpdate = false } = {}) {
  const rows = await q(`SELECT ${COLUMNS} FROM governance.data_classification_registry WHERE company_id = :companyId AND schema_name = :schema AND table_name = :table AND column_name = :column ${forUpdate ? 'FOR UPDATE' : ''}`,
    { companyId: tenant.companyId, schema, table, column }, transaction);
  return rows[0] ? present(rows[0]) : null;
}

/** Linhas de uma ou mais tabelas (para a classe do recurso). */
async function ofTables(tenant, pairs, transaction) {
  if (!pairs.length) return [];
  const rows = await q(`SELECT ${COLUMNS} FROM governance.data_classification_registry WHERE company_id = :companyId AND (schema_name || '.' || table_name) IN (SELECT jsonb_array_elements_text(CAST(:pairs AS jsonb)))`,
    { companyId: tenant.companyId, pairs: JSON.stringify(pairs) }, transaction);
  return rows.map(present);
}

async function list(tenant, filters, { limit, offset }, transaction) {
  const where = ['company_id = :companyId']; const r = { companyId: tenant.companyId, limit, offset };
  if (filters.schema) { where.push('schema_name = :schema'); r.schema = filters.schema; }
  if (filters.table) { where.push('table_name = :table'); r.table = filters.table; }
  if (filters.classification) { where.push('classification = :classification'); r.classification = filters.classification; }
  const [{ total }] = await q(`SELECT count(*)::int AS total FROM governance.data_classification_registry WHERE ${where.join(' AND ')}`, r, transaction);
  const rows = await q(`SELECT ${COLUMNS} FROM governance.data_classification_registry WHERE ${where.join(' AND ')} ORDER BY schema_name, table_name, column_name LIMIT :limit OFFSET :offset`, r, transaction);
  return { rows: rows.map(present), total };
}

async function insertOne(tenant, entry, actorUserId, transaction) {
  const rows = await q(
    `INSERT INTO governance.data_classification_registry (group_id, company_id, schema_name, table_name, column_name, entity, classification, purpose, retention_policy_id, masking, mask_pattern, exportability, ai_allowed, owner_domain, source, updated_by)
     VALUES (:groupId, :companyId, :schema, :table, :column, :entity, :classification, :purpose, :policyId, :masking, :maskPattern, :exportability, :aiAllowed, :ownerDomain, 'MANUAL', :actorUserId) RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, ...entry, actorUserId }, transaction
  );
  return present(rows[0]);
}

async function update(tenant, entry, actorUserId, transaction) {
  const rows = await q(
    `UPDATE governance.data_classification_registry SET classification = :classification, purpose = :purpose, retention_policy_id = :policyId, masking = :masking, mask_pattern = :maskPattern,
       exportability = :exportability, ai_allowed = :aiAllowed, owner_domain = :ownerDomain, source = 'MANUAL', version = version + 1, updated_by = :actorUserId, updated_at = now()
     WHERE company_id = :companyId AND schema_name = :schema AND table_name = :table AND column_name = :column RETURNING ${COLUMNS}`,
    { companyId: tenant.companyId, ...entry, actorUserId }, transaction
  );
  return present(rows[0]);
}

async function reviewItems(tenant, { limit, offset }, transaction) {
  const [{ total }] = await q("SELECT count(*)::int AS total FROM governance.classification_review_items WHERE company_id = :companyId AND status = 'OPEN'", { companyId: tenant.companyId }, transaction);
  const rows = await q("SELECT table_ref, record_id, legacy_value, converted_value, status, created_at FROM governance.classification_review_items WHERE company_id = :companyId AND status = 'OPEN' ORDER BY table_ref, record_id LIMIT :limit OFFSET :offset", { companyId: tenant.companyId, limit, offset }, transaction);
  return { rows, total };
}

/** A coluna existe no catálogo do banco? (colunas técnicas incluídas). */
async function columnExists(schema, table, column, transaction) {
  const rows = await q(`SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = :schema AND c.relname = :table AND a.attname = :column AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')`, { schema, table, column }, transaction);
  return rows.length > 0;
}

module.exports = { count, insertMissing, find, ofTables, list, insertOne, update, reviewItems, columnExists, present };
