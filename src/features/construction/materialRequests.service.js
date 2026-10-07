'use strict';

const { MaterialRequest, Project, ProjectStage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMaterialRequested, publishMaterialReceived } = require('./constructionEvents.service');
const { recordMovement } = require('../inventory/movements.service');

// M6-28 — requisição de material nascida da obra/etapa.
// GAP CORRIGIDO (auditoria pós-Marco 6, item 5): a versão anterior só registrava a requisição
// e marcava status RECEIVED, sem gerar o movimento de saída real no Estoque — o saldo de
// `inventory.inventory_items`/`inventory.stock_balances` nunca era debitado de fato.
// `receiveMaterialRequest` agora aceita opcionalmente `inventoryItemId` + `sourceLocationId` no
// momento do recebimento (quem recebe o material sabe de qual item/local do almoxarifado ele
// efetivamente saiu) e, quando informados, chama `inventory/movements.service.js#recordMovement`
// com um OUT real, vinculado ao `projectId` da obra (EST-004), dentro da MESMA transação —
// `InventoryMovement.sourceType='REQUISITION'`/`sourceId=materialRequest.id` dá a rastreabilidade
// de volta pra requisição, sem precisar de coluna nova em `construction.material_requests`
// (decisão de engenharia: evita uma migration de schema para este fix pontual — o vínculo vive
// no lado do Estoque, que já tem `source_type`/`source_id` para isso). Requisição sem esses
// dados no recebimento continua funcionando como antes (registro sem movimento), documentado,
// não escondido.
const STATUSES = ['REQUESTED', 'RECEIVED'];

async function createMaterialRequest(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, stageId, description, quantity, unit, idempotencyKey } = payload;
  if (!groupId || !companyId || !description || quantity == null || !unit) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "description", "quantity" e "unit" são obrigatórios.',
      'MATERIAL_REQUEST_VALIDATION'
    );
  }
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw AppError.badRequest('"quantity" precisa ser maior que zero.', 'MATERIAL_REQUEST_VALIDATION');
  }

  // Item 3 (fechamento de gaps pós-Marco 6) — mesmo padrão de captura offline do RDO (M6-94,
  // ver dailyReports.service.js#createDailyReport) e da medição (createStageMeasurement acima
  // no módulo): se esta `idempotencyKey` já criou uma requisição, devolve o registro existente
  // em vez de duplicar. O UNIQUE parcial do banco (migration 20260101000295) é a garantia final.
  if (idempotencyKey) {
    const existingByIdempotency = await MaterialRequest.findOne({ where: { idempotencyKey }, transaction });
    if (existingByIdempotency) {
      return existingByIdempotency;
    }
  }

  const project = await Project.findByPk(projectId, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  if (stageId) {
    const stage = await ProjectStage.findOne({ where: { id: stageId, projectId }, transaction });
    if (!stage) {
      throw AppError.badRequest('"stageId" não corresponde a uma etapa desta obra.', 'MATERIAL_REQUEST_STAGE_INVALID');
    }
  }

  const materialRequest = await MaterialRequest.create(
    {
      groupId,
      companyId,
      projectId,
      stageId: stageId || null,
      description,
      quantity,
      unit,
      status: 'REQUESTED',
      requestedByUserId: actorUserId || null,
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishMaterialRequested(materialRequest, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.material_request.create',
      entityType: 'MaterialRequest',
      entityId: materialRequest.id,
      afterJson: materialRequest.toJSON(),
      reason: `Requisição de material "${description}" criada para a obra ${projectId}.`,
    },
    transaction
  );

  return materialRequest;
}

async function listMaterialRequests(projectId, transaction, filters = {}) {
  const where = { projectId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return MaterialRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getMaterialRequest(id, transaction) {
  const materialRequest = await MaterialRequest.findByPk(id, { transaction });
  if (!materialRequest) throw AppError.notFound('Requisição de material não encontrada.', 'MATERIAL_REQUEST_NOT_FOUND');
  return materialRequest;
}

async function receiveMaterialRequest(id, actorUserId, transaction, stockLink = {}) {
  // Lock pessimista: mesma justificativa das outras máquinas de estado do módulo (ver
  // transitionProject em projects.service.js) — evita duas confirmações de recebimento
  // concorrentes disparando o evento `material.received` duas vezes para o mesmo registro.
  const materialRequest = await MaterialRequest.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!materialRequest) throw AppError.notFound('Requisição de material não encontrada.', 'MATERIAL_REQUEST_NOT_FOUND');
  const beforeJson = materialRequest.toJSON();

  if (materialRequest.status === 'RECEIVED') {
    throw AppError.conflict('Esta requisição de material já foi marcada como recebida.', 'MATERIAL_REQUEST_ALREADY_RECEIVED');
  }

  materialRequest.status = 'RECEIVED';
  materialRequest.receivedAt = new Date();
  materialRequest.updatedBy = actorUserId || null;
  await materialRequest.save({ transaction });

  // Baixa real de saldo no Estoque (gap corrigido — ver comentário de topo do arquivo). Só
  // dispara quando quem confirmou o recebimento informou de qual item/local do almoxarifado o
  // material saiu; sem isso, segue como antes (registro sem movimento).
  let inventoryMovement = null;
  const { inventoryItemId, sourceLocationId } = stockLink || {};
  if (inventoryItemId && sourceLocationId) {
    inventoryMovement = await recordMovement(
      {
        groupId: materialRequest.groupId,
        companyId: materialRequest.companyId,
        inventoryItemId,
        projectId: materialRequest.projectId,
        movementType: 'OUT',
        quantity: materialRequest.quantity,
        sourceLocationId,
        sourceType: 'REQUISITION',
        sourceId: materialRequest.id,
        idempotencyKey: `material_request.receive:${materialRequest.id}`,
        reason: `Consumo da requisição de material "${materialRequest.description}" na obra ${materialRequest.projectId}.`,
      },
      { userId: actorUserId, canApprove: false },
      transaction
    );
  }

  await publishMaterialReceived(materialRequest, transaction);

  await registrarAuditoria(
    {
      groupId: materialRequest.groupId,
      companyId: materialRequest.companyId,
      actorUserId,
      action: 'construction.material_request.receive',
      entityType: 'MaterialRequest',
      entityId: materialRequest.id,
      beforeJson,
      afterJson: { ...materialRequest.toJSON(), inventoryMovementId: inventoryMovement ? inventoryMovement.id : null },
      reason: `Requisição de material "${materialRequest.description}" marcada como recebida.`,
    },
    transaction
  );

  return materialRequest;
}

module.exports = {
  createMaterialRequest,
  listMaterialRequests,
  getMaterialRequest,
  receiveMaterialRequest,
  STATUSES,
};
