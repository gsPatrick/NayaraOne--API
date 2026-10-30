'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, source_system, entity, source_key, state, reason, source_version, source_payload, row_hash, target_entity_id, batch_id, last_position, source_deleted';

/** Registros já conhecidos entre as chaves, indexados por chave. */
async function loadByKeys(tenant, source, keys, transaction) {
  if (!keys.length) return new Map();
  const rows = await select(
    `SELECT ${COLUMNS} FROM governance.mig_records WHERE company_id = :companyId AND source_system = :system AND entity = :entity AND source_key IN (:keys)`,
    { companyId: tenant.companyId, system: source.source_system, entity: source.entity, keys }, transaction
  );
  return new Map(rows.map((row) => [row.source_key, row]));
}

/** Chaves de idempotência já aplicadas, entre as informadas. */
async function loadAppliedKeys(tenant, idempotencyKeys, transaction) {
  if (!idempotencyKeys.length) return new Set();
  const rows = await select('SELECT idempotency_key FROM governance.mig_event_keys WHERE company_id = :companyId AND idempotency_key IN (:keys)', { companyId: tenant.companyId, keys: idempotencyKeys }, transaction);
  return new Set(rows.map((row) => row.idempotency_key));
}

async function insertEventKey(tenant, idempotencyKey, batchId, transaction) {
  await sequelize.query(
    'INSERT INTO governance.mig_event_keys (group_id, company_id, idempotency_key, batch_id) VALUES (:groupId, :companyId, :key, :batchId) ON CONFLICT (company_id, idempotency_key) DO NOTHING',
    { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, key: idempotencyKey, batchId } }
  );
}

/** Grava (ou atualiza) o registro de origem. `fields` só traz o que muda; a chave natural é (empresa, sistema, entidade, chave). */
async function upsert(tenant, source, sourceKey, fields, transaction) {
  const [row] = await select(
    `INSERT INTO governance.mig_records (group_id, company_id, source_system, entity, source_key, state, reason, source_version, source_payload, row_hash, target_entity_id, batch_id, last_position, source_deleted)
     VALUES (:groupId, :companyId, :system, :entity, :key, :state, :reason, :version, CAST(:payload AS jsonb), :rowHash, :targetId, :batchId, :position, :deleted)
     ON CONFLICT (company_id, source_system, entity, source_key) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, source_version = EXCLUDED.source_version,
       source_payload = EXCLUDED.source_payload, row_hash = EXCLUDED.row_hash, target_entity_id = EXCLUDED.target_entity_id, batch_id = EXCLUDED.batch_id,
       last_position = EXCLUDED.last_position, source_deleted = EXCLUDED.source_deleted, updated_at = now() RETURNING ${COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, system: source.source_system, entity: source.entity, key: sourceKey, state: fields.state, reason: fields.reason ?? null,
      version: fields.sourceVersion || 1, payload: fields.payload === undefined ? null : JSON.stringify(fields.payload), rowHash: fields.rowHash ?? null, targetId: fields.targetEntityId ?? null,
      batchId: fields.batchId ?? null, position: fields.position ?? null, deleted: Boolean(fields.sourceDeleted),
    },
    transaction
  );
  return row;
}

/** Chaves do destino ainda não marcadas como excluídas na origem. */
async function listLiveKeys(tenant, source, transaction) {
  const rows = await select(
    'SELECT source_key FROM governance.mig_records WHERE company_id = :companyId AND source_system = :system AND entity = :entity AND NOT source_deleted AND state <> \'EXCLUDED\' ORDER BY source_key',
    { companyId: tenant.companyId, system: source.source_system, entity: source.entity }, transaction
  );
  return rows.map((row) => row.source_key);
}

/** Todos os registros da fonte (usado nos testes e na verificação de estado). */
function listAll(tenant, source, transaction) {
  return select(`SELECT ${COLUMNS} FROM governance.mig_records WHERE company_id = :companyId AND source_system = :system AND entity = :entity ORDER BY source_key`, { companyId: tenant.companyId, system: source.source_system, entity: source.entity }, transaction);
}

module.exports = { loadByKeys, loadAppliedKeys, insertEventKey, upsert, listLiveKeys, listAll };
