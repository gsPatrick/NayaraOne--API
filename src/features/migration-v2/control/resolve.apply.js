'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { RECORD } = require('../ingest/ingest.constants');
const records = require('../ingest/record.repository');
const { getTarget } = require('../ingest/targets');
const { writeTarget } = require('../ingest/applier.event');
const errors = require('./control.errors');
const { auditChange } = require('./record.transition');

/**
 * APPROVE (M9-D901 §3.1.1): aplica o registro em revisão com o aplicador da M9-D900 (grava o destino e o ID legado em core.external_refs na mesma transação) e o leva a MIGRATED.
 * A aprovação humana vale para a dúvida de duplicata; dado inválido (que iria para a quarentena) não é aprovável: 422 GOV_MIG_RECORD_UNAPPLICABLE e nada muda.
 */
async function approveRecord(tenant, actor, record, reason, transaction) {
  const row = record.source_payload || {};
  const verdict = await getTarget(record.entity).assess(tenant, row, record.target_entity_id, transaction);
  if (verdict && verdict.state === RECORD.QUARANTINED) throw errors.unapplicable(verdict.reason);
  const [batch] = record.batch_id
    ? await sequelize.query('SELECT id, run_id FROM governance.mig_batches WHERE company_id = :companyId AND id = :id', { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, id: record.batch_id } })
    : [null];
  const ctx = { tenant, actor, batch: batch || { id: null, run_id: null }, transaction };
  const source = { source_system: record.source_system, entity: record.entity };
  const targetId = await writeTarget(ctx, source, record.source_key, row, record);
  await records.upsert(tenant, source, record.source_key, {
    state: RECORD.MIGRATED, reason: null, sourceVersion: record.source_version, payload: row, rowHash: record.row_hash, targetEntityId: targetId, batchId: record.batch_id, position: record.last_position, sourceDeleted: record.source_deleted,
  }, transaction);
  await auditChange(tenant, actor, record, { state: RECORD.MIGRATED, decision: 'APPROVE', reason, target_entity_id: targetId }, reason, transaction);
  return { ...record, state: RECORD.MIGRATED, reason: null, target_entity_id: targetId };
}

module.exports = { approveRecord };
