'use strict';

const { MaterialRequest, Project, ProjectStage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMaterialRequested, publishMaterialReceived } = require('./constructionEvents.service');

// M6-28 — requisição mínima de material nascida da obra/etapa. DECISÃO DE ENGENHARIA: isto é
// o MÍNIMO esperado para o Marco 6 (registrar a requisição + marcar recebimento + eventos de
// domínio). A integração real com Estoque/Patrimônio (baixa de saldo, devolução com movimento
// inverso, perda com alçada de aprovação) é escopo do Marco 7 — ver
// migrations/20260101000236-create-construction-material_requests.js e a nota de escopo
// cruzado M6-53 no checklist do Marco 6.
const STATUSES = ['REQUESTED', 'RECEIVED'];

async function createMaterialRequest(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, stageId, description, quantity, unit } = payload;
  if (!groupId || !companyId || !description || quantity == null || !unit) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "description", "quantity" e "unit" são obrigatórios.',
      'MATERIAL_REQUEST_VALIDATION'
    );
  }
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw AppError.badRequest('"quantity" precisa ser maior que zero.', 'MATERIAL_REQUEST_VALIDATION');
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

async function receiveMaterialRequest(id, actorUserId, transaction) {
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
      afterJson: materialRequest.toJSON(),
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
