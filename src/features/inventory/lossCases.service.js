'use strict';

const { InventoryLossCase, InventoryItem, InventoryMovement } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishLossOpened } = require('./inventoryEvents.service');

// Guia do Marcelo §11/EST-010: perda/quebra/extravio não é baixa comum — abre loss_case com
// contexto+evidência; decisão humana (approve/reject) é quem efetivamente gera o movimento
// LOSS/DISPOSAL, nunca a criação do caso em si (EST-TS-10: loss sem evidência é bloqueado).
async function openLossCase(payload, actorUserId, transaction) {
  const { groupId, companyId, inventoryItemId, assetId, locationId, projectId, quantity, responsiblePersonId, context, evidenceFileIds, estimatedCost } = payload;

  if (!groupId || !companyId || !context) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "context" são obrigatórios.', 'LOSS_CASE_VALIDATION');
  }
  if (!inventoryItemId && !assetId) {
    throw AppError.badRequest('Informe "inventoryItemId" ou "assetId".', 'LOSS_CASE_VALIDATION');
  }
  // EST-TS-10: loss sem evidência é bloqueado quando o item for CONSUMABLE/TOOL de alto valor —
  // como o Caderno não fixa o limiar de valor em código (regra pertence ao Motor de Regras),
  // aplicamos aqui o mínimo seguro do próprio EST-TS-10: ao menos uma evidência é sempre exigida.
  if (!Array.isArray(evidenceFileIds) || evidenceFileIds.length === 0) {
    throw AppError.badRequest('Pelo menos um arquivo de evidência ("evidenceFileIds") é obrigatório (EST-TS-10).', 'LOSS_CASE_EVIDENCE_REQUIRED');
  }
  if (inventoryItemId && (quantity == null || Number(quantity) <= 0)) {
    throw AppError.badRequest('"quantity" > 0 é obrigatório quando "inventoryItemId" é informado.', 'LOSS_CASE_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 4): locationId era opcional aqui, mas
  // decideLossCase exige sourceLocationId pra gerar o movimento LOSS — sem essa validação na
  // criação, um caso de perda de item de estoque sem local ficava permanentemente travado em
  // OPEN (a aprovação sempre falhava), sem nenhuma forma de corrigir o local depois de criado.
  if (inventoryItemId && !locationId) {
    throw AppError.badRequest('"locationId" é obrigatório quando "inventoryItemId" é informado (necessário para aprovar a baixa depois).', 'LOSS_CASE_VALIDATION');
  }

  const lossCase = await InventoryLossCase.create(
    {
      groupId,
      companyId,
      inventoryItemId: inventoryItemId || null,
      assetId: assetId || null,
      locationId: locationId || null,
      projectId: projectId || null,
      quantity: inventoryItemId ? quantity : null,
      responsiblePersonId: responsiblePersonId || null,
      context,
      evidenceFileIds,
      estimatedCost: estimatedCost != null ? estimatedCost : null,
      status: 'OPEN',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishLossOpened(lossCase, transaction);

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_LOSS_CASE_OPENED', entityType: 'InventoryLossCase', entityId: lossCase.id, reason: 'Caso de perda/quebra/extravio aberto.' },
    transaction
  );

  return lossCase;
}

async function listLossCases(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return InventoryLossCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function decideLossCase(lossCaseId, decision, actor, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'LOSS_CASE_VALIDATION');
  }
  if (!actor.canApprove) {
    throw AppError.forbidden('Decidir um caso de perda exige a permissão inventory:approve.', 'LOSS_CASE_APPROVAL_REQUIRED');
  }

  const lossCase = await InventoryLossCase.findByPk(lossCaseId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!lossCase) throw AppError.notFound('Caso de perda não encontrado.', 'LOSS_CASE_NOT_FOUND');
  if (lossCase.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível decidir um caso em OPEN (atual: ${lossCase.status}).`, 'LOSS_CASE_INVALID_TRANSITION');
  }

  let movement = null;
  if (decision === 'APPROVED' && lossCase.inventoryItemId) {
    const item = await InventoryItem.findByPk(lossCase.inventoryItemId, { transaction });
    movement = await recordMovement(
      {
        groupId: lossCase.groupId,
        companyId: lossCase.companyId,
        inventoryItemId: lossCase.inventoryItemId,
        movementType: 'LOSS',
        quantity: lossCase.quantity,
        sourceLocationId: lossCase.locationId,
        projectId: lossCase.projectId,
        sourceType: 'LOSS_CASE',
        sourceId: lossCase.id,
        idempotencyKey: `loss-case:${lossCase.id}`,
        reason: `Perda aprovada — caso ${lossCase.id}.`,
        evidenceFileId: lossCase.evidenceFileIds[0],
        responsiblePersonId: item?.itemType === 'TOOL' || item?.itemType === 'ASSET' ? lossCase.responsiblePersonId : undefined,
      },
      actor,
      transaction
    );
    lossCase.resultingMovementId = movement.id;
  }

  lossCase.status = decision;
  lossCase.decidedByUserId = actor.userId || null;
  lossCase.decidedAt = new Date();
  lossCase.updatedBy = actor.userId || null;
  await lossCase.save({ transaction });

  await registrarAuditoria(
    { groupId: lossCase.groupId, companyId: lossCase.companyId, actorUserId: actor.userId, action: 'INVENTORY_LOSS_CASE_DECIDED', entityType: 'InventoryLossCase', entityId: lossCase.id, reason: `Caso de perda decidido: ${decision}.` },
    transaction
  );

  return lossCase;
}

module.exports = { openLossCase, listLossCases, decideLossCase };
