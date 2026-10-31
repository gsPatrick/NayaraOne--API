'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const errors = require('./integrity.errors');
const { ENTITY_SCHEMA_SEEDS } = require('./schema.seed');

const select = (entity, tenant, transaction) => sequelize.query(
  'SELECT field, type, scale FROM governance.mig_entity_schema WHERE company_id = :companyId AND entity = :entity ORDER BY position',
  { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, entity } }
);

/** Grava a semente da entidade para a empresa (idempotente; nunca sobrescreve campo já existente). */
async function seedEntity(tenant, entity, transaction) {
  const fields = ENTITY_SCHEMA_SEEDS[entity];
  if (!fields) return;
  for (const [index, def] of fields.entries()) {
     
    await sequelize.query(
      `INSERT INTO governance.mig_entity_schema (group_id, company_id, entity, position, field, type, scale) VALUES (:groupId, :companyId, :entity, :position, :field, :type, :scale)
       ON CONFLICT DO NOTHING`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, entity, position: index + 1, field: def.field, type: def.type, scale: def.scale === undefined ? null : def.scale } }
    );
  }
}

/** Esquema canônico da entidade, na ordem do hash. Sem linhas e sem semente: 422 GOV_MIG_SCHEMA_MISSING. */
async function loadSchema(tenant, entity, transaction) {
  let rows = await select(entity, tenant, transaction);
  if (!rows.length) {
    await seedEntity(tenant, entity, transaction);
    rows = await select(entity, tenant, transaction);
  }
  if (!rows.length) throw errors.schemaMissing(entity);
  return rows.map((row) => ({ field: row.field, type: row.type, scale: row.scale === null ? undefined : Number(row.scale) }));
}

module.exports = { loadSchema, seedEntity };
