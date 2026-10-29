'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { AUDIT, LOT_STATUS } = require('./bulk.constants');

/**
 * Tentativa bloqueada (sem permissão, lote grande demais, campo crítico sem evidência): a auditoria é gravada numa transação PRÓPRIA, porque a
 * transação da requisição é desfeita quando a recusa sobe (M9-D808 §3.1 passo 1 e critério 4).
 */
async function auditBlocked(tenant, actorUserId, details) {
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: AUDIT.BLOCKED, entityType: 'BulkChange', entityId: null, beforeJson: null, afterJson: details,
    reason: `Alteração em massa bloqueada: ${details.code}.`,
  });
}

/**
 * Lote FAILED (M9-D808 §3.1 passo 4): a transação do lote é desfeita (nenhum registro muda) e este registro da falha sobrevive, gravado à parte, com a
 * mesma Idempotency-Key (a unicidade só vale para lotes que não falharam, então a chave pode ser repetida).
 */
async function recordFailure(tenant, actorUserId, parsed, key, message) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true), set_config('app.user_id', :userId, true)", {
      transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId || '' },
    });
    const [lot] = await sequelize.query(
      `INSERT INTO governance.bulk_changes (group_id, company_id, entity_type, status, reason, filter_json, patch_json, affected_count, idempotency_key, request_hash, error_message, created_by)
       VALUES (:groupId, :companyId, :entityType, :status, :reason, CAST(:filter AS jsonb), CAST(:patch AS jsonb), 0, :key, :hash, :message, :actorUserId) RETURNING id`,
      {
        type: QueryTypes.SELECT, transaction,
        replacements: {
          groupId: tenant.groupId, companyId: tenant.companyId, entityType: parsed.entityType, status: LOT_STATUS.FAILED, reason: parsed.reason, filter: JSON.stringify(parsed.filter),
          patch: JSON.stringify(parsed.patch), key, hash: parsed.requestHash, message: String(message).slice(0, 500), actorUserId: actorUserId || null,
        },
      }
    );
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: AUDIT.FAILED, entityType: 'BulkChange', entityId: lot.id, beforeJson: null,
      afterJson: { entityType: parsed.entityType, filterHash: parsed.filterHash, error: String(message).slice(0, 200) }, reason: 'Alteração em massa falhou; nenhum registro foi alterado.',
    }, transaction);
  });
}

module.exports = { auditBlocked, recordFailure };
