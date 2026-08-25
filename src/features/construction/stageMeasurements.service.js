'use strict';

const { StageMeasurement } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishStageMeasurementDecided } = require('./constructionEvents.service');
const { getProjectStage } = require('./projectStages.service');

/**
 * createStageMeasurement — registra uma NOVA medição (append-only, nunca edita uma medição
 * já decidida). Nasce em PENDING_APPROVAL — só entra em vigor (atualiza
 * project_stages.measured_pct) depois de decideStageMeasurement aprovar.
 */
async function createStageMeasurement(projectStageId, payload, actorUserId, transaction) {
  const { groupId, companyId, measuredPct, measuredAt, notes } = payload;
  if (!groupId || !companyId || measuredPct === undefined || measuredPct === null || !measuredAt) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "measuredPct" e "measuredAt" são obrigatórios.',
      'STAGE_MEASUREMENT_VALIDATION'
    );
  }
  const numericPct = Number(measuredPct);
  if (!Number.isFinite(numericPct) || numericPct < 0 || numericPct > 100) {
    throw AppError.badRequest('"measuredPct" deve ser um número entre 0 e 100.', 'STAGE_MEASUREMENT_VALIDATION');
  }

  await getProjectStage(projectStageId, transaction);

  const measurement = await StageMeasurement.create(
    {
      groupId,
      companyId,
      projectStageId,
      measuredPct: numericPct,
      measuredAt,
      measuredByUserId: actorUserId || null,
      notes: notes || null,
      status: 'PENDING_APPROVAL',
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
      action: 'construction.stage_measurement.create',
      entityType: 'StageMeasurement',
      entityId: measurement.id,
      afterJson: measurement.toJSON(),
      reason: `Medição de ${numericPct}% registrada para a etapa ${projectStageId}, aguardando aprovação.`,
    },
    transaction
  );

  return measurement;
}

async function listStageMeasurements(projectStageId, transaction) {
  return StageMeasurement.findAll({ where: { projectStageId }, order: [['measured_at', 'DESC']], transaction });
}

async function getStageMeasurement(id, transaction) {
  const measurement = await StageMeasurement.findByPk(id, { transaction });
  if (!measurement) throw AppError.notFound('Medição não encontrada.', 'STAGE_MEASUREMENT_NOT_FOUND');
  return measurement;
}

/**
 * decideStageMeasurement — aprova ou rejeita uma medição PENDING_APPROVAL. Ao aprovar,
 * propaga measuredPct para project_stages.measured_pct (única forma de esse campo mudar —
 * nunca é editado diretamente via updateProjectStage).
 */
async function decideStageMeasurement(id, { decision, rejectionReason }, actorUserId, transaction) {
  const measurement = await getStageMeasurement(id, transaction);
  if (measurement.status !== 'PENDING_APPROVAL') {
    throw AppError.conflict(
      `Só é possível decidir uma medição "PENDING_APPROVAL" (atual: "${measurement.status}").`,
      'STAGE_MEASUREMENT_INVALID_STATUS'
    );
  }
  const normalizedDecision = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) {
    throw AppError.badRequest('"decision" deve ser "APPROVED" ou "REJECTED".', 'STAGE_MEASUREMENT_DECISION_INVALID');
  }

  const beforeJson = measurement.toJSON();
  measurement.status = normalizedDecision;
  measurement.approvedByUserId = actorUserId || null;
  measurement.decidedAt = new Date();
  if (normalizedDecision === 'REJECTED') measurement.rejectionReason = rejectionReason || null;
  measurement.updatedBy = actorUserId || null;
  await measurement.save({ transaction });

  if (normalizedDecision === 'APPROVED') {
    const stage = await getProjectStage(measurement.projectStageId, transaction);
    stage.measuredPct = measurement.measuredPct;
    stage.updatedBy = actorUserId || null;
    await stage.save({ transaction });
  }

  await publishStageMeasurementDecided(measurement, transaction);

  await registrarAuditoria(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      actorUserId,
      action: 'construction.stage_measurement.decide',
      entityType: 'StageMeasurement',
      entityId: measurement.id,
      beforeJson,
      afterJson: measurement.toJSON(),
      reason: `Medição ${measurement.id} ${normalizedDecision === 'APPROVED' ? 'aprovada' : 'rejeitada'}.`,
    },
    transaction
  );

  return measurement;
}

module.exports = { createStageMeasurement, listStageMeasurements, getStageMeasurement, decideStageMeasurement };
