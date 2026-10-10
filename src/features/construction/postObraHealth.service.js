'use strict';

const { Op } = require('sequelize');
const { MaintenanceCase, WarrantyAction, Project } = require('../../models');
const AppError = require('../../utils/AppError');

// M6-100 (fechado 30/09/2026, 2ª rodada) — read model SEPARADO do de saúde da obra em
// andamento (`projectHealth.service.js`), dedicado a garantia/pós-obra: total de casos
// abertos/fechados, tempo médio de atendimento, custo total de mão de obra + material em
// ações de garantia, e casos por nível de escalonamento. Alimenta o painel "Pós-obra"
// separado do painel "Obras" no Centro de Comando (M6-100), sem misturar dado de obra em
// andamento com dado de pós-entrega.

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function getProject(id, transaction) {
  const project = await Project.findByPk(id, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  return project;
}

async function getPostObraHealth(projectId, transaction) {
  await getProject(projectId, transaction);

  const cases = await MaintenanceCase.findAll({ where: { projectId }, transaction });
  const caseIds = cases.map((c) => c.id);
  const actions = caseIds.length
    ? await WarrantyAction.findAll({ where: { warrantyCaseId: { [Op.in]: caseIds } }, transaction })
    : [];

  const openCases = cases.filter((c) => c.status !== 'CLOSED');
  const closedCases = cases.filter((c) => c.status === 'CLOSED');

  // Tempo médio de atendimento: createdAt -> updatedAt dos casos fechados. Não existe campo
  // dedicado `closedAt` no schema físico atual (lacuna documental da fonte, mesma categoria de
  // M6-103) — usar `updatedAt` do momento em que o status virou CLOSED é o proxy mais preciso
  // disponível sem migration nova, documentado aqui em vez de inventar precisão que não existe.
  // BUG CORRIGIDO (smoke test, 30/09/2026): o model MaintenanceCase usa `createdAt: 'created_at'`
  // como opção de timestamps, o que renomeia o atributo JS para `created_at` (snake_case), não
  // apenas o nome da coluna — `c.createdAt`/`c.updatedAt` (camelCase) sempre retornava
  // `undefined`, fazendo `avgResolutionHours` ficar sempre `null`, mesmo com casos fechados de
  // verdade. Corrigido para ler `created_at`/`updated_at`, confirmado via smoke test manual.
  const resolutionTimesMs = closedCases
    .map((c) => new Date(c.updated_at).getTime() - new Date(c.created_at).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const avgResolutionHours = resolutionTimesMs.length
    ? round2(resolutionTimesMs.reduce((acc, ms) => acc + ms, 0) / resolutionTimesMs.length / (1000 * 60 * 60))
    : null;

  const totalLaborCost = cases.reduce((acc, c) => acc + toNumber(c.laborCost), 0) + actions.reduce((acc, a) => acc + toNumber(a.cost), 0);
  const totalMaterialCost = cases.reduce((acc, c) => acc + toNumber(c.materialCost), 0);

  const casesByEscalationLevel = cases.reduce((acc, c) => {
    const level = c.escalationLevel || 'NONE';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, { NONE: 0, WARNING: 0, CRITICAL: 0, OVERDUE: 0 });

  return {
    totalCases: cases.length,
    openCases: openCases.length,
    closedCases: closedCases.length,
    avgResolutionHours,
    totalLaborCost: round2(totalLaborCost),
    totalMaterialCost: round2(totalMaterialCost),
    totalWarrantyCost: round2(totalLaborCost + totalMaterialCost),
    casesByEscalationLevel,
    totalWarrantyActions: actions.length,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getPostObraHealth };
