'use strict';

const { Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishProjectCreated, publishProjectStatusChanged } = require('./constructionEvents.service');

// DECISÃO DE ENGENHARIA: os documentos fonte não definem os valores válidos de
// projects.status (coluna STRING(32) livre, só com default 'PLANNED') — workflow linear
// abaixo é uma decisão de engenharia, seguindo o mesmo padrão de máquina de estados linear
// já usado em legal.contracts (contracts.service.js).
const STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const VALID_TRANSITIONS = {
  PLANNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

async function createProject(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, name, responsibleUserId, budgetAmount, startsAt, endsAtPlanned } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'PROJECT_VALIDATION');
  }

  const project = await Project.create(
    {
      groupId,
      companyId,
      propertyId: propertyId || null,
      name,
      responsibleUserId: responsibleUserId || null,
      budgetAmount: budgetAmount != null ? budgetAmount : null,
      startsAt: startsAt || null,
      endsAtPlanned: endsAtPlanned || null,
      status: 'PLANNED',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishProjectCreated(project, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.project.create',
      entityType: 'Project',
      entityId: project.id,
      afterJson: project.toJSON(),
      reason: `Obra "${project.name}" criada.`,
    },
    transaction
  );

  return project;
}

async function listProjects(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return Project.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getProject(id, transaction) {
  const project = await Project.findByPk(id, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  return project;
}

async function updateProject(id, payload, actorUserId, transaction) {
  const project = await getProject(id, transaction);
  const beforeJson = project.toJSON();
  const { name, responsibleUserId, budgetAmount, startsAt, endsAtPlanned, propertyId } = payload;
  if (name !== undefined) project.name = name;
  if (responsibleUserId !== undefined) project.responsibleUserId = responsibleUserId;
  if (budgetAmount !== undefined) project.budgetAmount = budgetAmount;
  if (startsAt !== undefined) project.startsAt = startsAt;
  if (endsAtPlanned !== undefined) project.endsAtPlanned = endsAtPlanned;
  if (propertyId !== undefined) project.propertyId = propertyId;
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.update',
      entityType: 'Project',
      entityId: project.id,
      beforeJson,
      afterJson: project.toJSON(),
      reason: `Obra "${project.name}" atualizada.`,
    },
    transaction
  );

  return project;
}

async function transitionProject(id, targetStatus, actorUserId, transaction) {
  const project = await getProject(id, transaction);
  const normalizedTarget = String(targetStatus || '').toUpperCase();
  if (!STATUSES.includes(normalizedTarget)) {
    throw AppError.badRequest(`"targetStatus" deve ser um de: ${STATUSES.join(', ')}.`, 'PROJECT_STATUS_INVALID');
  }
  const allowed = VALID_TRANSITIONS[project.status] || [];
  if (!allowed.includes(normalizedTarget)) {
    throw AppError.conflict(
      `Não é possível mover a obra de "${project.status}" para "${normalizedTarget}".`,
      'PROJECT_STATUS_TRANSITION_INVALID'
    );
  }

  const fromStatus = project.status;
  project.status = normalizedTarget;
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await publishProjectStatusChanged(project, fromStatus, transaction);

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.status_change',
      entityType: 'Project',
      entityId: project.id,
      beforeJson: { status: fromStatus },
      afterJson: { status: project.status },
      reason: `Obra "${project.name}" transicionada de "${fromStatus}" para "${project.status}".`,
    },
    transaction
  );

  return project;
}

module.exports = { createProject, listProjects, getProject, updateProject, transitionProject, STATUSES };
