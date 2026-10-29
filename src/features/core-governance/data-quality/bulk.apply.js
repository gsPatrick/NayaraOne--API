'use strict';

const { hashPiiValue } = require('../../people/personDocumentFormat.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishPropertyUpdated } = require('../../properties/propertyEvents.service');
const { recordFieldChangeEvidence } = require('./evidence.guard');
const { comparable } = require('./evidence.criticalFields');
const { AUDIT, AUDIT_ENTITY, RECORD_TYPES } = require('./bulk.constants');
const repository = require('./bulk.repository');
const { valuesOf } = require('./bulk.plan');

/** Hash (HMAC) do valor de um campo; o valor em claro fica só na auditoria individual (mesmo critério da M9-D807). */
const hashOf = (field, value) => (comparable(value) === null ? null : hashPiiValue(`${field}\u0000${comparable(value)}`));
const side = (fields, which) => Object.fromEntries(Object.entries(fields).map(([name, change]) => [name, change[which]]));

async function write(change, ctx) {
  if (change.recordType === RECORD_TYPES.REVIEW_ITEM) {
    await repository.setReviewSteward(change.instance.id, change.fields.assignedStewardId.after, ctx.transaction);
    return;
  }
  change.instance.set(valuesOf(change.fields));
  change.instance.updatedBy = ctx.actorUserId;
  await change.instance.save({ transaction: ctx.transaction });
  if (change.recordType === RECORD_TYPES.PROPERTY) await publishPropertyUpdated(change.instance, ctx.transaction);
}

/**
 * Grava as alterações do plano (M9-D808 §3.1 passo 2), todas na transação da requisição: atualiza o registro, grava a origem/evidência dos campos
 * críticos (D807), audita CADA registro com antes, depois e `bulk_change_id` e cria o item do lote só com os hashes. Qualquer falha sobe e a
 * transação inteira é desfeita. Devolve quantos registros mudaram.
 */
async function applyPlan(tenant, lot, plan, ctx) {
  for (const change of plan.changes) {
    await write(change, ctx);
    if (change.assertion) await recordFieldChangeEvidence(change.entity, change.assertion, { transaction: ctx.transaction, actorUserId: ctx.actorUserId });
    const audit = await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: ctx.actorUserId, action: AUDIT.ITEM, entityType: AUDIT_ENTITY[change.recordType], entityId: change.instance.id,
      beforeJson: { ...side(change.fields, 'before'), bulk_change_id: lot.id }, afterJson: { ...side(change.fields, 'after'), bulk_change_id: lot.id },
      reason: `Alteração em massa (lote ${lot.id}): ${lot.reason}`,
    }, ctx.transaction);
    await repository.insertItem(tenant, lot.id, {
      recordType: change.recordType, recordId: change.instance.id, auditLogId: audit.id,
      fieldHashes: Object.fromEntries(Object.entries(change.fields).map(([name, value]) => [name, { before: hashOf(name, value.before), after: hashOf(name, value.after) }])),
    }, ctx.transaction);
  }
  return plan.changes.length;
}

/** Auditoria do lote como um todo (quem, o quê, quantos). */
function auditLot(tenant, lot, parsed, count, ctx) {
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: ctx.actorUserId, action: AUDIT.EXECUTED, entityType: 'BulkChange', entityId: lot.id, beforeJson: null,
    afterJson: { entityType: parsed.entityType, affectedCount: count, filterHash: parsed.filterHash, fields: Object.keys(parsed.patch), bulk_change_id: lot.id },
    reason: `Alteração em massa executada: ${count} registro(s) alterado(s). Motivo: ${lot.reason}`,
  }, ctx.transaction);
}

module.exports = { applyPlan, auditLot };
