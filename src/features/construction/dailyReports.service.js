'use strict';

const { DailyReport, DailyWorker, DailyMaterial } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishDailyLogCreated } = require('./constructionEvents.service');

const DEFAULT_SHIFT_CODE = 'UNICO';

function normalizeShiftCode(shiftCode) {
  return shiftCode ? String(shiftCode).toUpperCase() : DEFAULT_SHIFT_CODE;
}

function validateWorkforceCount(workforceCount) {
  if (workforceCount === undefined || workforceCount === null) return;
  const numericWorkforce = Number(workforceCount);
  if (!Number.isFinite(numericWorkforce) || numericWorkforce < 0) {
    throw AppError.badRequest('"workforceCount" deve ser um número maior ou igual a zero.', 'DAILY_REPORT_WORKFORCE_INVALID');
  }
}

/**
 * M6-08 — grava a equipe do dia (vinculada a Pessoa/Fornecedor) para um RDO. `workers` é uma
 * lista de `{ personId, role }`. Não falha silenciosamente: cada item exige `personId`.
 */
async function replaceDailyWorkers(dailyReportId, workers, tenant, actorUserId, transaction) {
  if (!Array.isArray(workers)) return;
  await DailyWorker.destroy({ where: { dailyReportId }, transaction, force: true });
  for (const worker of workers) {
    if (!worker || !worker.personId) {
      throw AppError.badRequest('Cada item de "workers" precisa de "personId".', 'DAILY_WORKER_VALIDATION');
    }
    await DailyWorker.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        dailyReportId,
        personId: worker.personId,
        role: worker.role || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
}

/**
 * M6-09 — grava os materiais usados no dia. `materials` é uma lista de
 * `{ materialDescription, quantity, unit }`.
 */
async function replaceDailyMaterials(dailyReportId, materials, tenant, actorUserId, transaction) {
  if (!Array.isArray(materials)) return;
  await DailyMaterial.destroy({ where: { dailyReportId }, transaction, force: true });
  for (const material of materials) {
    if (!material || !material.materialDescription || material.quantity == null || !material.unit) {
      throw AppError.badRequest(
        'Cada item de "materials" precisa de "materialDescription", "quantity" e "unit".',
        'DAILY_MATERIAL_VALIDATION'
      );
    }
    await DailyMaterial.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        dailyReportId,
        materialDescription: material.materialDescription,
        quantity: material.quantity,
        unit: material.unit,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
}

async function createDailyReport(projectId, payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    reportDate,
    shiftCode,
    weather,
    workforceCount,
    occurrences,
    servicesPerformed,
    workers,
    materials,
    clientLocalId,
    idempotencyKey,
    evidenceFileIds,
  } = payload;
  if (!groupId || !companyId || !reportDate) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "reportDate" são obrigatórios.', 'DAILY_REPORT_VALIDATION');
  }
  validateWorkforceCount(workforceCount);
  const normalizedShiftCode = normalizeShiftCode(shiftCode);

  // M6-94: captura offline — se o app já reenviou esta `idempotencyKey`, devolve o registro
  // existente em vez de duplicar (o UNIQUE parcial do banco é a garantia final, mas checamos
  // aqui antes para devolver o registro certo, não um erro de conflito genérico).
  if (idempotencyKey) {
    const existingByIdempotency = await DailyReport.findOne({ where: { idempotencyKey }, transaction });
    if (existingByIdempotency) {
      return existingByIdempotency;
    }
  }

  // M6-07/M6-58: chave lógica é (project_id, report_date, shift_code) — permite mais de um
  // turno por dia sem colidir.
  const existing = await DailyReport.findOne({
    where: { projectId, reportDate, shiftCode: normalizedShiftCode },
    transaction,
  });
  if (existing) {
    throw AppError.conflict('Já existe um RDO para esta obra nesta data e turno.', 'DAILY_REPORT_DUPLICATE');
  }

  const report = await DailyReport.create(
    {
      groupId,
      companyId,
      projectId,
      reportDate,
      shiftCode: normalizedShiftCode,
      weather: weather || null,
      workforceCount: workforceCount != null ? workforceCount : null,
      occurrences: occurrences || null,
      servicesPerformed: servicesPerformed || null,
      evidenceFileIds: Array.isArray(evidenceFileIds) ? evidenceFileIds : [],
      reportedByUserId: actorUserId || null,
      clientLocalId: clientLocalId || null,
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await replaceDailyWorkers(report.id, workers, { groupId, companyId }, actorUserId, transaction);
  await replaceDailyMaterials(report.id, materials, { groupId, companyId }, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.daily_report.create',
      entityType: 'DailyReport',
      entityId: report.id,
      afterJson: report.toJSON(),
      reason: `RDO de ${reportDate} (turno ${normalizedShiftCode}) registrado para a obra ${projectId}.`,
    },
    transaction
  );

  // M6-73 (corrigido em 30/09/2026 — auditoria pós-merge encontrou a ausência): evento de
  // domínio nunca era disparado na criação de RDO, apesar de já existir no motor de eventos
  // do módulo. Nome canônico exigido pela fonte, sem prefixo `construction.`.
  await publishDailyLogCreated(report, transaction);

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

/**
 * M6-20 — segue a cadeia `supersedes_id` a partir de um registro qualquer da cadeia até achar a
 * revisão mais recente (aquela que nenhum outro registro aponta como `supersedesId`).
 */
async function getCurrentDailyReport(id, transaction) {
  let current = await getDailyReport(id, transaction);
  // Segue para a frente: se existe algum registro mais novo que substitui o atual, avança.
  // Como não guardamos um ponteiro "para frente", localizamos por busca reversa.
  let next = await DailyReport.findOne({ where: { supersedesId: current.id }, transaction });
  while (next) {
    current = next;
    next = await DailyReport.findOne({ where: { supersedesId: current.id }, transaction });
  }
  return current;
}

/**
 * M6-20 (BUG CORRIGIDO) — "corrigir" um RDO já criado NUNCA sobrescreve a linha original.
 * Em vez de UPDATE in-place, cria uma NOVA linha com `supersedesId` apontando para o registro
 * anterior. O registro original permanece intacto no banco, preservando o histórico completo
 * (mesmo padrão append-only já usado em Contratos/Financeiro — ver M6-20 do CHECKLIST_DE_ESCOPO
 * do Marco 6). Ler o RDO "atual" de um projeto/data deve sempre seguir a cadeia até a revisão
 * mais recente (`getCurrentDailyReport`).
 */
async function correctDailyReport(id, payload, actorUserId, transaction) {
  const original = await getCurrentDailyReport(id, transaction);
  const { weather, workforceCount, occurrences, servicesPerformed, workers, materials, evidenceFileIds } = payload;
  validateWorkforceCount(workforceCount);

  const revision = await DailyReport.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      projectId: original.projectId,
      reportDate: original.reportDate,
      shiftCode: original.shiftCode,
      weather: weather !== undefined ? weather : original.weather,
      workforceCount: workforceCount !== undefined ? workforceCount : original.workforceCount,
      occurrences: occurrences !== undefined ? occurrences : original.occurrences,
      servicesPerformed: servicesPerformed !== undefined ? servicesPerformed : original.servicesPerformed,
      evidenceFileIds: Array.isArray(evidenceFileIds) ? evidenceFileIds : original.evidenceFileIds,
      reportedByUserId: original.reportedByUserId,
      supersedesId: original.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await replaceDailyWorkers(
    revision.id,
    workers,
    { groupId: original.groupId, companyId: original.companyId },
    actorUserId,
    transaction
  );
  await replaceDailyMaterials(
    revision.id,
    materials,
    { groupId: original.groupId, companyId: original.companyId },
    actorUserId,
    transaction
  );

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'construction.daily_report.correct',
      entityType: 'DailyReport',
      entityId: revision.id,
      beforeJson: original.toJSON(),
      afterJson: revision.toJSON(),
      reason: `RDO ${original.id} corrigido por nova revisão ${revision.id} (append-only, original preservado).`,
    },
    transaction
  );

  return revision;
}

// Alias mantido por compatibilidade de nome de endpoint — o efeito é sempre append-only.
const updateDailyReport = correctDailyReport;

module.exports = {
  createDailyReport,
  listDailyReports,
  getDailyReport,
  getCurrentDailyReport,
  correctDailyReport,
  updateDailyReport,
};
