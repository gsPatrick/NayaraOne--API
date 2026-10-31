'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Pareamento (M9-D903 §3.2): chave do legado -> id do Nayara, pelas referências vigentes de core.external_refs (D906). */
async function currentRefs(tenant, sourceSystem, entityType, transaction) {
  const rows = await select(
    'SELECT source_key, entity_id FROM core.external_refs WHERE company_id = :companyId AND source_system = :sourceSystem AND entity_type = :entityType AND valid_to IS NULL',
    { companyId: tenant.companyId, sourceSystem, entityType }, transaction
  );
  return new Map(rows.map((row) => [row.source_key, row.entity_id]));
}

/** Chaves que a migração já deu como excluídas na origem (exclusão lógica): sumir de um lado e ficar marcado do outro é coerente, não é diferença. */
async function deletedKeys(tenant, sourceSystem, entity, transaction) {
  const rows = await select(
    'SELECT source_key FROM governance.mig_records WHERE company_id = :companyId AND source_system = :sourceSystem AND entity = :entity AND source_deleted', { companyId: tenant.companyId, sourceSystem, entity }, transaction
  );
  return new Set(rows.map((row) => row.source_key));
}

const sourceFor = (tenant, sourceSystem, entity, transaction) => select(
  `SELECT id, source_system, entity, mode, config, secret_ref FROM governance.mig_sources WHERE company_id = :companyId AND source_system = :sourceSystem AND entity = :entity AND enabled`,
  { companyId: tenant.companyId, sourceSystem, entity }, transaction
).then((rows) => rows[0] || null);

module.exports = { currentRefs, deletedKeys, sourceFor };
