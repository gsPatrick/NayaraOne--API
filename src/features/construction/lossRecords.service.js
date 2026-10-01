'use strict';

const { LossRecord, ApprovalThreshold } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// DECISÃO DE ENGENHARIA (M6-14/M6-29): valor-padrão de alçada quando a empresa ainda não
// configurou uma linha em "construction"."approval_thresholds" — ver comentário completo na
// migration 20260101000217-create-construction-approval_thresholds.js. Configurável por
// empresa (tabela), este número é só o fallback de fábrica.
const DEFAULT_MAX_AUTO_APPROVE_AMOUNT = 1000.0;
const CONTEXT_MATERIAL_LOSS = 'MATERIAL_LOSS';

async function getApprovalThreshold(groupId, companyId, context, transaction) {
  const row = await ApprovalThreshold.findOne({ where: { companyId, context }, transaction });
  return row ? Number(row.maxAutoApproveAmount) : DEFAULT_MAX_AUTO_APPROVE_AMOUNT;
}

async function upsertApprovalThreshold(payload, actorUserId, transaction) {
  const { groupId, companyId, context, maxAutoApproveAmount } = payload;
  if (!groupId || !companyId || maxAutoApproveAmount == null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "maxAutoApproveAmount" são obrigatórios.',
      'APPROVAL_THRESHOLD_VALIDATION'
    );
  }
  const normalizedContext = context ? String(context).toUpperCase() : CONTEXT_MATERIAL_LOSS;
  const [row] = await ApprovalThreshold.findOrCreate({
    where: { companyId, context: normalizedContext },
    defaults: { groupId, companyId, context: normalizedContext, maxAutoApproveAmount, createdBy: actorUserId || null },
    transaction,
  });
  row.maxAutoApproveAmount = maxAutoApproveAmount;
  row.updatedBy = actorUserId || null;
  await row.save({ transaction });
  return row;
}

/**
 * createLossRecord — regra de alçada (M6-14/M6-29/M6-60): se `estimatedValue` estiver dentro do
 * limite configurado (`approval_thresholds.max_auto_approve_amount`), o registro já nasce
 * APPROVED (autoaprovação). Acima do limite, nasce PENDING_APPROVAL e exige uma chamada
 * explícita a `approveLossRecord` antes de virar APPROVED — nunca autoaprova valor alto.
 */
async function createLossRecord(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, materialDescription, quantity, estimatedValue, reason } = payload;
  if (!groupId || !companyId || !materialDescription || quantity == null || estimatedValue == null || !reason) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "materialDescription", "quantity", "estimatedValue" e "reason" são obrigatórios.',
      'LOSS_RECORD_VALIDATION'
    );
  }
  if (Number(quantity) <= 0) {
    throw AppError.badRequest('"quantity" deve ser maior que zero.', 'LOSS_RECORD_QUANTITY_INVALID');
  }

  const threshold = await getApprovalThreshold(groupId, companyId, CONTEXT_MATERIAL_LOSS, transaction);
  const withinThreshold = Number(estimatedValue) <= threshold;

  const lossRecord = await LossRecord.create(
    {
      groupId,
      companyId,
      projectId,
      materialDescription,
      quantity,
      estimatedValue,
      reason,
      movementType: 'LOSS',
      status: withinThreshold ? 'APPROVED' : 'PENDING_APPROVAL',
      approvedByUserId: withinThreshold ? actorUserId || null : null,
      approvedAt: withinThreshold ? new Date() : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.loss_record.create',
      entityType: 'LossRecord',
      entityId: lossRecord.id,
      afterJson: lossRecord.toJSON(),
      reason: withinThreshold
        ? `Perda de material autoaprovada (valor ${estimatedValue} dentro da alçada de ${threshold}).`
        : `Perda de material pendente de aprovação (valor ${estimatedValue} acima da alçada de ${threshold}).`,
    },
    transaction
  );

  return lossRecord;
}

async function getLossRecord(id, transaction) {
  const item = await LossRecord.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Registro de perda não encontrado.', 'LOSS_RECORD_NOT_FOUND');
  return item;
}

async function listLossRecords(projectId, transaction, filters = {}) {
  const where = { projectId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return LossRecord.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

/**
 * approveLossRecord — aprovação explícita de perda acima da alçada (M6-29). Fail-closed: só
 * aceita registros em PENDING_APPROVAL; nunca aprova um DRAFT/APPROVED/RETURN diretamente.
 */
async function approveLossRecord(id, actorUserId, transaction) {
  const lossRecord = await LossRecord.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!lossRecord) throw AppError.notFound('Registro de perda não encontrado.', 'LOSS_RECORD_NOT_FOUND');
  if (lossRecord.status !== 'PENDING_APPROVAL') {
    // Achado numa auditoria do cliente (30/09/2026): mensagem sem enum cru em inglês.
    const statusLabel = lossRecord.status === 'APPROVED' ? 'já aprovado' : 'rejeitado';
    throw AppError.conflict(
      `Só é possível aprovar um registro ainda aguardando aprovação — este já está ${statusLabel}.`,
      'LOSS_RECORD_APPROVAL_INVALID_STATUS'
    );
  }

  const beforeJson = lossRecord.toJSON();
  lossRecord.status = 'APPROVED';
  lossRecord.approvedByUserId = actorUserId || null;
  lossRecord.approvedAt = new Date();
  lossRecord.updatedBy = actorUserId || null;
  await lossRecord.save({ transaction });

  await registrarAuditoria(
    {
      groupId: lossRecord.groupId,
      companyId: lossRecord.companyId,
      actorUserId,
      action: 'construction.loss_record.approve',
      entityType: 'LossRecord',
      entityId: lossRecord.id,
      beforeJson,
      afterJson: lossRecord.toJSON(),
      reason: 'Perda de material aprovada explicitamente (acima da alçada).',
    },
    transaction
  );

  return lossRecord;
}

/**
 * returnLossRecord — devolução de material (M6-28/M6-60): gera um NOVO registro RETURN que
 * aponta para o LOSS original via `relatedLossRecordId`, nunca um UPDATE que apaga o valor
 * perdido original (mesmo espírito append-only usado no diário de obra/Financeiro). A
 * devolução corrige o SALDO calculado (ver `getMaterialBalance`), não o registro histórico.
 */
async function returnLossRecord(id, payload, actorUserId, transaction) {
  const original = await getLossRecord(id, transaction);
  if (original.movementType !== 'LOSS') {
    throw AppError.badRequest('Só é possível devolver material a partir de um registro do tipo "LOSS".', 'LOSS_RECORD_RETURN_INVALID_SOURCE');
  }
  if (original.status !== 'APPROVED') {
    throw AppError.conflict('Só é possível devolver material de uma perda já aprovada.', 'LOSS_RECORD_RETURN_REQUIRES_APPROVED');
  }

  const returnQuantity = payload && payload.quantity != null ? Number(payload.quantity) : Number(original.quantity);
  if (returnQuantity <= 0 || returnQuantity > Number(original.quantity)) {
    throw AppError.badRequest(
      `"quantity" da devolução deve ser maior que zero e não pode exceder a quantidade original (${original.quantity}).`,
      'LOSS_RECORD_RETURN_QUANTITY_INVALID'
    );
  }
  const returnValue = (returnQuantity / Number(original.quantity)) * Number(original.estimatedValue);

  const returnRecord = await LossRecord.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      projectId: original.projectId,
      materialDescription: original.materialDescription,
      quantity: returnQuantity,
      estimatedValue: returnValue,
      // Achado numa varredura final do Front do Marco 6 (30/09/2026): o motivo padrão da
      // devolução expunha o UUID interno cru do registro original direto na tela do usuário
      // ("Devolução do registro de perda <uuid>") — usa a descrição do material (já disponível
      // e legível), não o id interno.
      reason: (payload && payload.reason) || `Devolução de "${original.materialDescription}" (perda original de ${Number(original.quantity)} un.).`,
      movementType: 'RETURN',
      relatedLossRecordId: original.id,
      status: 'APPROVED',
      approvedByUserId: actorUserId || null,
      approvedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'construction.loss_record.return',
      entityType: 'LossRecord',
      entityId: returnRecord.id,
      afterJson: returnRecord.toJSON(),
      reason: `Movimento inverso (devolução) de ${returnQuantity} de "${original.materialDescription}" referente à perda ${original.id}.`,
    },
    transaction
  );

  return returnRecord;
}

/**
 * getMaterialBalance — saldo de material de uma obra (M6-60): soma de LOSS aprovado (negativo)
 * + RETURN aprovado (positivo). Usado para comprovar que devolução corrige o saldo.
 */
async function getMaterialBalance(projectId, materialDescription, transaction) {
  const records = await LossRecord.findAll({
    where: { projectId, materialDescription, status: 'APPROVED' },
    transaction,
  });
  let quantityBalance = 0;
  let valueBalance = 0;
  for (const record of records) {
    const sign = record.movementType === 'RETURN' ? 1 : -1;
    quantityBalance += sign * Number(record.quantity);
    valueBalance += sign * Number(record.estimatedValue);
  }
  return { projectId, materialDescription, quantityBalance, valueBalance };
}

module.exports = {
  createLossRecord,
  listLossRecords,
  getLossRecord,
  approveLossRecord,
  returnLossRecord,
  getMaterialBalance,
  upsertApprovalThreshold,
  getApprovalThreshold,
  DEFAULT_MAX_AUTO_APPROVE_AMOUNT,
  CONTEXT_MATERIAL_LOSS,
};
