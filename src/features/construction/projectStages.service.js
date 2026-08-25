'use strict';

const { ProjectStage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

async function createProjectStage(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, name, sequence, plannedPct, startsAt, endsAt } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'PROJECT_STAGE_VALIDATION');
  }

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
  if (status !== undefined) stage.status = status;
  if (startsAt !== undefined) stage.startsAt = startsAt;
  if (endsAt !== undefined) stage.endsAt = endsAt;
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

module.exports = { createProjectStage, listProjectStages, getProjectStage, updateProjectStage };
