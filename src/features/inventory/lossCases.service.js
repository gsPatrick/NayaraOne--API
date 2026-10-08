'use strict';

const { InventoryLossCase, InventoryItem, Asset, InventoryToolLoan, InventoryMovement, File } = require('../../models');
const { Op } = require('sequelize');
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
  // BUG REAL CORRIGIDO (auditoria Marco 7, EST-TS-10, 2026-10-07): `[null]`/ids inventados
  // passavam no `length > 0`, abrindo um caso de perda "com evidência" sem nenhum arquivo real
  // por trás. Exige que todo id seja uma string não vazia E que cada um aponte pra um File
  // de verdade, da mesma empresa (nunca de outro tenant).
  if (!Array.isArray(evidenceFileIds) || evidenceFileIds.length === 0 || evidenceFileIds.some((id) => !id || typeof id !== 'string')) {
    throw AppError.badRequest('Pelo menos um arquivo de evidência ("evidenceFileIds") é obrigatório (EST-TS-10).', 'LOSS_CASE_EVIDENCE_REQUIRED');
  }
  const uniqueEvidenceFileIds = [...new Set(evidenceFileIds)];
  const evidenceFiles = await File.findAll({ where: { id: { [Op.in]: uniqueEvidenceFileIds }, companyId }, transaction });
  if (evidenceFiles.length !== uniqueEvidenceFileIds.length) {
    throw AppError.badRequest('Um ou mais arquivos de evidência ("evidenceFileIds") não existem ou não pertencem a esta empresa.', 'LOSS_CASE_EVIDENCE_FILE_NOT_FOUND');
  }
  if (inventoryItemId && (quantity == null || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0)) {
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

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 28, 2026-10-05): aprovar um loss_case
  // de Asset/ferramenta (assetId, em vez de inventoryItemId) nunca tocava o próprio Asset — o
  // mesmo cuidado já aplicado em toolLoans.service.js (R21/R22, status/custodiante/localização
  // sincronizados a cada transição) nunca foi estendido ao fluxo de perda. Resultado: um ativo
  // declarado perdido/quebrado e aprovado continuava AVAILABLE/LOANED, podia ser emprestado de
  // novo, e mantinha o custodiante antigo mesmo após a perda ser formalizada (EST-010).
  if (decision === 'APPROVED' && lossCase.assetId) {
    const asset = await Asset.findByPk(lossCase.assetId, { transaction, lock: transaction.LOCK.UPDATE });
    if (asset) {
      asset.status = 'LOST';
      asset.assignedToUserId = null;
      asset.updatedBy = actor.userId || null;
      await asset.save({ transaction });
    }

    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 30, 2026-10-05): aprovar a perda
    // de um Asset que ainda tinha um InventoryToolLoan OPEN/OVERDUE deixava esse empréstimo
    // "esquecido" — qualquer returnTool posterior sobre ele reescrevia asset.status de volta
    // pra AVAILABLE/MAINTENANCE, revertendo a perda formalizada sem controle nenhum (mesma
    // classe de bug da R29, aqui no caminho returnTool em vez de openMaintenanceOrder). Fecha
    // o(s) empréstimo(s) aberto(s) como LOST — status terminal, nunca mais aceito por returnTool.
    await InventoryToolLoan.update(
      { status: 'LOST', updatedBy: actor.userId || null },
      { where: { assetId: lossCase.assetId, status: { [Op.in]: ['OPEN', 'OVERDUE'] } }, transaction }
    );
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
