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
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): maxAutoApproveAmount
  // era persistido sem Number.isFinite/teto de sanidade — "Infinity"/"1e999" fazia TODA perda ou
  // garantia auto-aprovar (Number(x) <= Infinity é sempre true), quebrando a alçada de aprovação;
  // "NaN" também passava (maxAutoApproveAmount == null é falso pra string "NaN").
  const numericThreshold = Number(maxAutoApproveAmount);
  if (!Number.isFinite(numericThreshold) || numericThreshold < 0) {
    throw AppError.badRequest('"maxAutoApproveAmount" deve ser um número não negativo.', 'APPROVAL_THRESHOLD_VALIDATION');
  }
  if (numericThreshold > 1_000_000_000_000) {
    throw AppError.badRequest('"maxAutoApproveAmount" excede o limite permitido.', 'APPROVAL_THRESHOLD_VALIDATION');
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
 *
 * BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-09 — mesmo padrão do achado em
 * inventory.movements.service.js/recordMovement para ADJUSTMENT/LOSS/DISPOSAL): registrar uma
 * perda é uma operação REEXECUTÁVEL (retry de rede/duplo-clique no mesmo lançamento manual) e,
 * dentro da alçada, AUTOAPROVA na hora — sem nenhum humano no caminho para notar a duplicidade
 * antes do valor entrar em totalLossValue (projectHealth.service.js/dashboard.service.js).
 * idempotencyKey agora é obrigatória; reenvio com a mesma chave devolve o registro já criado em
 * vez de duplicar (migration 20260101000326-add-idempotency-key-to-loss-records.js).
 */
async function createLossRecord(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, materialDescription, quantity, estimatedValue, reason, idempotencyKey } = payload;
  if (!groupId || !companyId || !materialDescription || quantity == null || estimatedValue == null || !reason) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "materialDescription", "quantity", "estimatedValue" e "reason" são obrigatórios.',
      'LOSS_RECORD_VALIDATION'
    );
  }
  if (!idempotencyKey) {
    throw AppError.badRequest(
      'O campo "idempotencyKey" é obrigatório — evita duplicar o registro de perda (e sua autoaprovação) em caso de retry/duplo-clique.',
      'LOSS_RECORD_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw AppError.badRequest('"quantity" deve ser maior que zero.', 'LOSS_RECORD_QUANTITY_INVALID');
  }
  if (!Number.isFinite(Number(estimatedValue)) || Number(estimatedValue) < 0) {
    throw AppError.badRequest('"estimatedValue" deve ser um número maior ou igual a zero.', 'LOSS_RECORD_VALUE_INVALID');
  }

  // Idempotência: reenvio do mesmo payload (ex.: retry de rede) não cria um segundo registro —
  // devolve o já criado, mesmo padrão de recordMovement/stageMeasurements.
  const existingByKey = await LossRecord.findOne({ where: { companyId, idempotencyKey }, transaction });
  if (existingByKey) return existingByKey;

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
      idempotencyKey,
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
  const original = await LossRecord.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!original) throw AppError.notFound('Registro de perda não encontrado.', 'LOSS_RECORD_NOT_FOUND');
  if (original.movementType !== 'LOSS') {
    throw AppError.badRequest('Só é possível devolver material a partir de um registro do tipo "LOSS".', 'LOSS_RECORD_RETURN_INVALID_SOURCE');
  }
  if (original.status !== 'APPROVED') {
    throw AppError.conflict('Só é possível devolver material de uma perda já aprovada.', 'LOSS_RECORD_RETURN_REQUIRES_APPROVED');
  }

  // FIX (auditoria 01/10/2026): devoluções anteriores do MESMO registro de perda não eram
  // somadas — cada clique em "Registrar devolução" aceitava até 100% da quantidade original de
  // novo, inflando o saldo de material indefinidamente. Agora soma todos os RETURN aprovados já
  // vinculados a este LOSS (relatedLossRecordId) e valida contra o saldo restante.
  const existingReturns = await LossRecord.findAll({
    where: { relatedLossRecordId: original.id, movementType: 'RETURN', status: 'APPROVED' },
    transaction,
  });
  const alreadyReturnedQuantity = existingReturns.reduce((sum, r) => sum + Number(r.quantity), 0);
  const remainingQuantity = Number(original.quantity) - alreadyReturnedQuantity;

  const returnQuantity = payload && payload.quantity != null ? Number(payload.quantity) : remainingQuantity;
  // FIX (auditoria Marco 6, ciclo 1 novo): faltava Number.isFinite — "quantity": "NaN" não
  // satisfaz nem `<= 0` nem `> remainingQuantity` (ambos false pra NaN), passando o guard e
  // criando um RETURN com quantity/estimatedValue = NaN (categoria 14 do catálogo).
  if (!Number.isFinite(returnQuantity) || returnQuantity <= 0 || returnQuantity > remainingQuantity) {
    throw AppError.badRequest(
      `"quantity" da devolução deve ser maior que zero e não pode exceder a quantidade ainda disponível para devolução (${remainingQuantity} de ${original.quantity}).`,
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
      // FIX (auditoria E2E de browser, 01/10/2026): Number().toString() usa ponto como separador
      // decimal (padrão JS), aparecendo cru no meio de um texto PT-BR que usa vírgula em todo o
      // resto da tela (ex.: "perda original de 3.25 un." em vez de "3,25 un.").
      reason: (payload && payload.reason) || `Devolução de "${original.materialDescription}" (perda original de ${String(Number(original.quantity)).replace('.', ',')} un.).`,
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
