'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, group_id, company_id, source_system, entity, mode, mode_reason, config, secret_ref, enabled, checkpoint_token, checkpoint_at';

function list(tenant, { sourceSystem, entity }, transaction) {
  return select(
    `SELECT ${COLUMNS} FROM governance.mig_sources WHERE company_id = :companyId AND enabled AND (:sourceSystem::text IS NULL OR source_system = :sourceSystem) AND (:entity::text IS NULL OR entity = :entity) ORDER BY source_system, entity`,
    { companyId: tenant.companyId, sourceSystem: sourceSystem || null, entity: entity || null }, transaction
  );
}

async function get(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_sources WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/** Trava a fonte pelo resto da transação (linha + advisory lock): dois aplicadores da mesma fonte se serializam. */
async function lock(tenant, id, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { transaction, replacements: { key: `mig_source:${id}` } });
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_sources WHERE company_id = :companyId AND id = :id FOR UPDATE`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

function setCheckpoint(tenant, id, token, transaction) {
  return sequelize.query('UPDATE governance.mig_sources SET checkpoint_token = :token, checkpoint_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id', {
    transaction, replacements: { companyId: tenant.companyId, id, token },
  });
}

module.exports = { list, get, lock, setCheckpoint };
