'use strict';

const { ProjectStage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE'];

function assertValidDateRange(startsAt, endsAt) {
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw AppError.badRequest('"endsAt" não pode ser anterior a "startsAt".', 'PROJECT_STAGE_DATE_RANGE_INVALID');
  }
}

async function createProjectStage(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, name, sequence, plannedPct, startsAt, endsAt } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'PROJECT_STAGE_VALIDATION');
  }
  assertValidDateRange(startsAt, endsAt);

  const stage = await ProjectStage.create(
    {
      groupId,
      companyId,
      projectId,
      name,
      sequence: sequence != null ? sequence : 1,
      plannedPct: plannedPct != null ? plannedPct : null,
      measuredPct: null,
      status: 'PENDING',
      startsAt: startsAt || null,
      endsAt: endsAt || null,
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
      action: 'construction.stage.create',
      entityType: 'ProjectStage',
      entityId: stage.id,
      afterJson: stage.toJSON(),
      reason: `Etapa "${stage.name}" criada para a obra ${projectId}.`,
    },
    transaction
  );

  return stage;
}

async function listProjectStages(projectId, transaction) {
  return ProjectStage.findAll({ where: { projectId }, order: [['sequence', 'ASC']], transaction });
}

async function getProjectStage(id, transaction) {
  const stage = await ProjectStage.findByPk(id, { transaction });
  if (!stage) throw AppError.notFound('Etapa de obra não encontrada.', 'PROJECT_STAGE_NOT_FOUND');
  return stage;
}

async function updateProjectStage(id, payload, actorUserId, transaction) {
  const stage = await getProjectStage(id, transaction);
  const beforeJson = stage.toJSON();
  const { name, sequence, plannedPct, status, startsAt, endsAt } = payload;
  if (name !== undefined) stage.name = name;
  if (sequence !== undefined) stage.sequence = sequence;
  if (plannedPct !== undefined) stage.plannedPct = plannedPct;
  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`"status" deve ser um de: ${STATUSES.join(', ')}.`, 'PROJECT_STAGE_STATUS_INVALID');
    }
    stage.status = normalizedStatus;
  }
  if (startsAt !== undefined) stage.startsAt = startsAt;
  if (endsAt !== undefined) stage.endsAt = endsAt;
  assertValidDateRange(
    startsAt !== undefined ? startsAt : stage.startsAt,
    endsAt !== undefined ? endsAt : stage.endsAt
  );
  stage.updatedBy = actorUserId || null;
  await stage.save({ transaction });

  await registrarAuditoria(
    {
      groupId: stage.groupId,
      companyId: stage.companyId,
      actorUserId,
      action: 'construction.stage.update',
      entityType: 'ProjectStage',
      entityId: stage.id,
      beforeJson,
      afterJson: stage.toJSON(),
      reason: `Etapa "${stage.name}" atualizada.`,
    },
    transaction
  );

  return stage;
}

module.exports = { createProjectStage, listProjectStages, getProjectStage, updateProjectStage, STATUSES };
