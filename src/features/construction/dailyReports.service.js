'use strict';

const { DailyReport } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

async function createDailyReport(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, reportDate, weather, workforceCount, occurrences } = payload;
  if (!groupId || !companyId || !reportDate) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "reportDate" são obrigatórios.', 'DAILY_REPORT_VALIDATION');
  }

  const existing = await DailyReport.findOne({ where: { projectId, reportDate }, transaction });
  if (existing) {
    throw AppError.conflict('Já existe um RDO para esta obra nesta data.', 'DAILY_REPORT_DUPLICATE');
  }

  const report = await DailyReport.create(
    {
      groupId,
      companyId,
      projectId,
      reportDate,
      weather: weather || null,
      workforceCount: workforceCount != null ? workforceCount : null,
      occurrences: occurrences || null,
      reportedByUserId: actorUserId || null,
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
      action: 'construction.daily_report.create',
      entityType: 'DailyReport',
      entityId: report.id,
      afterJson: report.toJSON(),
      reason: `RDO de ${reportDate} registrado para a obra ${projectId}.`,
    },
    transaction
  );

  return report;
}

async function listDailyReports(projectId, transaction) {
  return DailyReport.findAll({ where: { projectId }, order: [['report_date', 'DESC']], transaction });
}

async function getDailyReport(id, transaction) {
  const report = await DailyReport.findByPk(id, { transaction });
  if (!report) throw AppError.notFound('RDO não encontrado.', 'DAILY_REPORT_NOT_FOUND');
  return report;
}

async function updateDailyReport(id, payload, actorUserId, transaction) {
  const report = await getDailyReport(id, transaction);
  const beforeJson = report.toJSON();
  const { weather, workforceCount, occurrences } = payload;
  if (weather !== undefined) report.weather = weather;
  if (workforceCount !== undefined) report.workforceCount = workforceCount;
  if (occurrences !== undefined) report.occurrences = occurrences;
  report.updatedBy = actorUserId || null;
  await report.save({ transaction });

  await registrarAuditoria(
    {
      groupId: report.groupId,
      companyId: report.companyId,
      actorUserId,
      action: 'construction.daily_report.update',
      entityType: 'DailyReport',
      entityId: report.id,
      beforeJson,
      afterJson: report.toJSON(),
      reason: `RDO ${report.id} atualizado.`,
    },
    transaction
  );

  return report;
}

module.exports = { createDailyReport, listDailyReports, getDailyReport, updateDailyReport };
