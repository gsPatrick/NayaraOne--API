'use strict';

const { ApprovalThreshold } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Alçada de aprovação de Obras por valor (Caderno Obras §8 "Perda/quebra exige ... aprovação conforme valor"; §9
 * "Desconto/ressarcimento passa por regra/aprovação e Financeiro"). Verificação independente do Marco 6 (M6-29, M6-107,
 * M6-96):
 *  - o valor é configuração da empresa (construction.approval_thresholds), um por contexto; não há mais número fixo no
 *    código. A migration 20260101006605 gravou para cada empresa existente o valor que valia até aqui. Empresa sem
 *    alçada configurada para o contexto: nada se autoaprova (0, o mais conservador — DI-M6V-6);
 *  - alterar exige a permissão própria construction:approval_threshold:manage e MFA recente (na rota) e deixa
 *    auditoria com antes e depois.
 */
const CONTEXTS = ['MATERIAL_LOSS', 'WARRANTY_RESOLUTION'];
const NOT_CONFIGURED_AMOUNT = 0;
const MAX_AMOUNT = 999999999999.99; // scanner:allow — teto técnico da coluna NUMERIC(18,2), não regra de negócio

async function getApprovalThreshold(groupId, companyId, context, transaction) {
  const row = await ApprovalThreshold.findOne({ where: { companyId, context }, transaction });
  return row ? Number(row.maxAutoApproveAmount) : NOT_CONFIGURED_AMOUNT;
}

async function listApprovalThresholds(companyId, transaction) {
  const rows = await ApprovalThreshold.findAll({ where: { companyId }, transaction });
  const byContext = new Map(rows.map((r) => [r.context, r]));
  return CONTEXTS.map((context) => {
    const row = byContext.get(context);
    return { context, configured: Boolean(row), maxAutoApproveAmount: row ? Number(row.maxAutoApproveAmount) : NOT_CONFIGURED_AMOUNT, id: row ? row.id : null, updatedAt: row ? row.updatedAt : null, updatedBy: row ? row.updatedBy : null };
  });
}

async function upsertApprovalThreshold(payload, actorUserId, transaction) {
  const { groupId, companyId, context, maxAutoApproveAmount } = payload || {};
  if (!groupId || !companyId || maxAutoApproveAmount === undefined || maxAutoApproveAmount === null || maxAutoApproveAmount === '') {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "maxAutoApproveAmount" são obrigatórios.', 'APPROVAL_THRESHOLD_VALIDATION');
  }
  // "Infinity"/"NaN"/negativo nunca viram alçada (Infinity faria tudo se autoaprovar).
  const amount = Number(maxAutoApproveAmount);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) {
    throw AppError.badRequest('"maxAutoApproveAmount" deve ser um número não negativo, dentro do limite técnico do campo.', 'APPROVAL_THRESHOLD_VALIDATION');
  }
  const normalizedContext = context ? String(context).toUpperCase() : 'MATERIAL_LOSS';
  if (!CONTEXTS.includes(normalizedContext)) {
    throw AppError.badRequest(`"context" deve ser um de: ${CONTEXTS.join(', ')}.`, 'APPROVAL_THRESHOLD_VALIDATION');
  }
  const value = amount.toFixed(2);
  let row = await ApprovalThreshold.findOne({ where: { companyId, context: normalizedContext }, transaction, lock: transaction.LOCK.UPDATE });
  const beforeJson = row ? row.toJSON() : null;
  if (row) {
    row.maxAutoApproveAmount = value;
    row.updatedBy = actorUserId || null;
    await row.save({ transaction });
  } else {
    row = await ApprovalThreshold.create(
      { groupId, companyId, context: normalizedContext, maxAutoApproveAmount: value, createdBy: actorUserId || null, updatedBy: actorUserId || null },
      { transaction }
    );
  }
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: beforeJson ? 'construction.approval_threshold.update' : 'construction.approval_threshold.create',
      entityType: 'ApprovalThreshold',
      entityId: row.id,
      beforeJson,
      afterJson: row.toJSON(),
      reason: `Alçada de ${normalizedContext === 'MATERIAL_LOSS' ? 'perda de material' : 'desconto/ressarcimento de garantia'} ${beforeJson ? `alterada de ${beforeJson.maxAutoApproveAmount} para` : 'definida em'} ${value}.`,
    },
    transaction
  );
  return row;
}

module.exports = { CONTEXTS, getApprovalThreshold, listApprovalThresholds, upsertApprovalThreshold };
