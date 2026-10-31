'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { canTransition } = require('./record.states');
const errors = require('./control.errors');
const { UUID } = require('../externalRefs.input');

const COLUMNS = 'id, source_system, entity, source_key, state, reason, source_version, source_payload, row_hash, target_entity_id, batch_id, last_position, source_deleted';

/** Lê o registro da empresa travando a linha até o fim da transação (decisões simultâneas sobre o mesmo registro se serializam). */
async function lockRecord(tenant, recordId, transaction) {
  if (!UUID.test(String(recordId || ''))) throw errors.recordNotFound();
  const [row] = await sequelize.query(`SELECT ${COLUMNS} FROM governance.mig_records WHERE company_id = :companyId AND id = :id FOR UPDATE`, {
    type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, id: recordId },
  });
  if (!row) throw errors.recordNotFound();
  return row;
}

/** Audita a mudança de estado do registro com o antes e o depois. */
function auditChange(tenant, actor, record, after, reason, transaction) {
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: 'migration.record.resolved', entityType: 'MigRecord', entityId: record.id,
    beforeJson: { state: record.state, reason: record.reason, source_system: record.source_system, entity: record.entity, source_key: record.source_key },
    afterJson: after, reason,
  }, transaction);
}

/**
 * Muda o estado de um registro respeitando a máquina de estados (M9-D901 §3.1). O contador da Torre acompanha pelo gatilho do banco, na mesma transação. O registro precisa
 * estar travado por `lockRecord`. Transição fora da tabela: 409 GOV_MIG_RECORD_INVALID_TRANSITION.
 */
async function transitionLocked(tenant, actor, record, to, { reason, decision }, transaction) {
  if (!canTransition(record.state, to)) throw errors.invalidTransition(record.state, decision);
  await sequelize.query('UPDATE governance.mig_records SET state = :to, reason = :reason, updated_at = now() WHERE company_id = :companyId AND id = :id AND state = :from', {
    transaction, replacements: { companyId: tenant.companyId, id: record.id, to, from: record.state, reason },
  });
  await auditChange(tenant, actor, record, { state: to, decision: decision || null, reason }, reason, transaction);
  return { ...record, state: to, reason };
}

/** Atalho: trava e muda. */
async function transitionRecord(tenant, actor, recordId, to, options, transaction) {
  const record = await lockRecord(tenant, recordId, transaction);
  return transitionLocked(tenant, actor, record, to, options || {}, transaction);
}

module.exports = { lockRecord, transitionLocked, transitionRecord, auditChange, COLUMNS };
