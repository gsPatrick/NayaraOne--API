'use strict';

const { MaintenanceCase } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMaintenanceCaseOpened } = require('./constructionEvents.service');

// DECISÃO DE ENGENHARIA: status de MaintenanceCase (pós-obra/garantia) é STRING(32) livre nas
// fontes, sem enum documentado — workflow abaixo segue o mesmo padrão de "chamado" já usado
// em finance.approval_requests e crm.opportunities (aberto -> em andamento -> resolvido/fechado).
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

async function createMaintenanceCase(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, projectId, openedByPersonId, responsibleUserId, description, warrantyDeadlineAt } = payload;
  if (!groupId || !companyId || !propertyId || !description) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "propertyId" e "description" são obrigatórios.',
      'MAINTENANCE_CASE_VALIDATION'
    );
  }

  const maintenanceCase = await MaintenanceCase.create(
    {
      groupId,
      companyId,
      propertyId,
      projectId: projectId || null,
      openedByPersonId: openedByPersonId || null,
      responsibleUserId: responsibleUserId || null,
      description,
      status: 'OPEN',
      warrantyDeadlineAt: warrantyDeadlineAt || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishMaintenanceCaseOpened(maintenanceCase, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.maintenance_case.create',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      afterJson: maintenanceCase.toJSON(),
      reason: `Chamado de pós-obra aberto para o imóvel ${propertyId}.`,
    },
    transaction
  );

  return maintenanceCase;
}

async function listMaintenanceCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.projectId) where.projectId = filters.projectId;
  return MaintenanceCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getMaintenanceCase(id, transaction) {
  const maintenanceCase = await MaintenanceCase.findByPk(id, { transaction });
  if (!maintenanceCase) throw AppError.notFound('Chamado de pós-obra não encontrado.', 'MAINTENANCE_CASE_NOT_FOUND');
  return maintenanceCase;
}

async function updateMaintenanceCase(id, payload, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction);
  const beforeJson = maintenanceCase.toJSON();
  const { status, description, responsibleUserId } = payload;
  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`"status" deve ser um de: ${STATUSES.join(', ')}.`, 'MAINTENANCE_CASE_STATUS_INVALID');
    }
    maintenanceCase.status = normalizedStatus;
  }
  if (description !== undefined) maintenanceCase.description = description;
  if (responsibleUserId !== undefined) maintenanceCase.responsibleUserId = responsibleUserId;
  maintenanceCase.updatedBy = actorUserId || null;
  await maintenanceCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.maintenance_case.update',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      beforeJson,
      afterJson: maintenanceCase.toJSON(),
      reason: `Chamado de pós-obra ${maintenanceCase.id} atualizado.`,
    },
    transaction
  );

  return maintenanceCase;
}

async function removeMaintenanceCase(id, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction);
  const beforeJson = maintenanceCase.toJSON();
  maintenanceCase.deletedBy = actorUserId || null;
  await maintenanceCase.save({ transaction });
  await maintenanceCase.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.maintenance_case.delete',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      beforeJson,
      reason: `Chamado de pós-obra ${maintenanceCase.id} excluído.`,
    },
    transaction
  );

  return { id: maintenanceCase.id };
}

module.exports = {
  createMaintenanceCase,
  listMaintenanceCases,
  getMaintenanceCase,
  updateMaintenanceCase,
  removeMaintenanceCase,
  STATUSES,
};
