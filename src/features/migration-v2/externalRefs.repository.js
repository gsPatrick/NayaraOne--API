'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

const COLUMNS = 'id, group_id, company_id, entity_type, entity_id, source_system, source_key, is_primary, valid_from, valid_to, migration_run_id, created_at';
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Referência vigente da chave (empresa + sistema + tipo + chave). */
async function findCurrentByKey(tenant, { sourceSystem, entityType, sourceKey }, transaction) {
  const [row] = await select(
    `SELECT ${COLUMNS} FROM core.external_refs WHERE company_id = :companyId AND source_system = :sourceSystem AND entity_type = :entityType AND source_key = :sourceKey AND valid_to IS NULL`,
    { companyId: tenant.companyId, sourceSystem, entityType, sourceKey }, transaction
  );
  return row || null;
}

/** Há ID primário vigente da entidade neste sistema? */
async function hasCurrentPrimary(tenant, entityId, sourceSystem, transaction) {
  const [row] = await select(
    'SELECT 1 AS found FROM core.external_refs WHERE company_id = :companyId AND entity_id = :entityId AND source_system = :sourceSystem AND valid_to IS NULL AND is_primary',
    { companyId: tenant.companyId, entityId, sourceSystem }, transaction
  );
  return Boolean(row);
}

async function insert(tenant, input, isPrimary, transaction) {
  const [row] = await select(
    `INSERT INTO core.external_refs (group_id, company_id, entity_type, entity_id, source_system, source_key, is_primary, valid_from, migration_run_id)
     VALUES (:groupId, :companyId, :entityType, :entityId, :sourceSystem, :sourceKey, :isPrimary, COALESCE(:validFrom::timestamptz, now()), :migrationRunId) RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, ...input, isPrimary, validFrom: input.validFrom ? input.validFrom.toISOString() : null }, transaction
  );
  return row;
}

/** Vigentes de uma entidade, primárias primeiro; travadas para o reapontamento. */
function lockCurrentOfEntity(tenant, entityId, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM core.external_refs WHERE company_id = :companyId AND entity_id = :entityId AND valid_to IS NULL ORDER BY is_primary DESC, created_at, source_key FOR UPDATE`,
    { companyId: tenant.companyId, entityId }, transaction
  );
}

async function close(tenant, id, transaction) {
  const [row] = await select(
    `UPDATE core.external_refs SET valid_to = GREATEST(now(), valid_from) WHERE company_id = :companyId AND id = :id AND valid_to IS NULL RETURNING ${COLUMNS}`,
    { companyId: tenant.companyId, id }, transaction
  );
  return row || null;
}

async function findById(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM core.external_refs WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/** Referências da chave que valiam em `at` (ausente = agora), de qualquer tipo ou só do tipo pedido. */
function findAt(tenant, { sourceSystem, sourceKey, entityType, at }, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM core.external_refs
      WHERE company_id = :companyId AND source_system = :sourceSystem AND source_key = :sourceKey AND (:entityType::text IS NULL OR entity_type = :entityType)
        AND valid_from <= COALESCE(:at::timestamptz, now()) AND (valid_to IS NULL OR valid_to > COALESCE(:at::timestamptz, now())) ORDER BY valid_from DESC`,
    { companyId: tenant.companyId, sourceSystem, sourceKey, entityType: entityType || null, at: at ? at.toISOString() : null }, transaction
  );
}

module.exports = { findCurrentByKey, hasCurrentPrimary, insert, lockCurrentOfEntity, close, findById, findAt };
