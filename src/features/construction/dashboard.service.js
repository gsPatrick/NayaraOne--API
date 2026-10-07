'use strict';

const { Op } = require('sequelize');
const {
  Project,
  ProjectStage,
  BudgetLine,
  ChangeOrder,
  FinancialEntry,
  StageMeasurement,
  Nonconformity,
  LossRecord,
  MaintenanceCase,
  WarrantyAction,
} = require('../../models');

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): o contrato ("CONSTRUÇÃO + OBRAS + PÓS-OBRA —
// BLINDADO v1", seção "Painéis principais" e "9. KPIs Obras" do caderno de BI) exige DOIS
// painéis dedicados no Centro de Comando — "Obras" e "Pós-obra" — com dado AGREGADO DE TODAS
// AS OBRAS da empresa, não só o drill-down de uma obra específica (que já existe em
// projectHealth.service.js/getProjectHealth, por obra). Este read model segue o MESMO padrão
// já estabelecido para dashboards agregados no sistema (ver src/features/crm/dashboard.service.js,
// M3-17): soma/agrega diretamente das tabelas vivas, sem tabela materializada — nunca drifta em
// relação aos read models por obra, e é simples o bastante pra não precisar de refresh job.
//
// KPIs Obras exigidos (seção 9 do caderno de BI): progresso x cronograma; baseline/actual/
// forecast; margem projetada; atrasos; medições; não conformidades; desperdício; custo
// pós-obra; recorrência por causa/equipe/material.

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const DELIVERED_LIKE_STATUSES = ['DELIVERED', 'WARRANTY', 'CLOSED'];

async function getConstructionDashboard(filters, transaction) {
  const { groupId, companyId } = filters || {};

  const projects = await Project.findAll({ where: { groupId, companyId }, transaction });
  const projectIds = projects.map((p) => p.id);

  // --- Painel "Obras" (todas as obras da empresa, qualquer status) ---
  const projectsByStatus = projects.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  const overdueProjects = projects.filter(
    (p) =>
      p.endsAtPlanned &&
      new Date(p.endsAtPlanned).getTime() < Date.now() &&
      !['FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED'].includes(p.status)
  );

  const [budgetLines, changeOrders, settledEntries, stages, nonconformities, lossRecords] = await Promise.all([
    projectIds.length ? BudgetLine.findAll({ where: { projectId: { [Op.in]: projectIds } }, transaction }) : [],
    projectIds.length
      ? ChangeOrder.findAll({ where: { projectId: { [Op.in]: projectIds }, status: 'APPROVED' }, transaction })
      : [],
    projectIds.length
      ? FinancialEntry.findAll({
          where: { constructionProjectId: { [Op.in]: projectIds }, nature: 'PAYABLE', status: { [Op.in]: ['SETTLED', 'PARTIALLY_SETTLED'] } },
          transaction,
        })
      : [],
    projectIds.length ? ProjectStage.findAll({ where: { projectId: { [Op.in]: projectIds } }, transaction }) : [],
    projectIds.length ? Nonconformity.findAll({ where: { projectId: { [Op.in]: projectIds } }, transaction }) : [],
    projectIds.length
      ? LossRecord.findAll({ where: { projectId: { [Op.in]: projectIds }, movementType: { [Op.in]: ['LOSS', 'RETURN'] }, status: 'APPROVED' }, transaction })
      : [],
  ]);

  const committedCostTotal = budgetLines.reduce((acc, l) => acc + toNumber(l.plannedAmount), 0);
  const baselineBudgetTotal = projects.reduce(
    (acc, p) => acc + (p.budgetAmount !== null && p.budgetAmount !== undefined ? toNumber(p.budgetAmount) : 0),
    0
  );
  const approvedChangesTotal = changeOrders.reduce((acc, c) => acc + toNumber(c.budgetImpact), 0);
  const actualFinancialCostTotal = settledEntries.reduce((acc, e) => acc + toNumber(e.amount), 0);
  const forecastToCompleteTotal = Math.max(committedCostTotal + approvedChangesTotal - actualFinancialCostTotal, 0);
  const projectedTotalCostTotal = round2(actualFinancialCostTotal + forecastToCompleteTotal);
  const marginBudgetBaseTotal = committedCostTotal + approvedChangesTotal;
  const projectedMarginTotal = round2(marginBudgetBaseTotal - projectedTotalCostTotal);
  const projectedMarginPct = marginBudgetBaseTotal > 0 ? round2((projectedMarginTotal / marginBudgetBaseTotal) * 100) : null;

  const avgPhysicalProgressPct = stages.length
    ? round2(stages.reduce((acc, s) => acc + toNumber(s.measuredPct), 0) / stages.length)
    : null;
  const avgPlannedProgressPct = stages.length
    ? round2(stages.reduce((acc, s) => acc + toNumber(s.plannedPct), 0) / stages.length)
    : null;

  const openNonconformities = nonconformities.filter((nc) => nc.status !== 'CLOSED').length;

  const totalLossValue = lossRecords.reduce((acc, l) => {
    const sign = l.movementType === 'RETURN' ? -1 : 1;
    return acc + sign * toNumber(l.estimatedValue);
  }, 0);
  const wastagePct = baselineBudgetTotal > 0 ? round2((Math.max(totalLossValue, 0) / baselineBudgetTotal) * 100) : null;

  const measurements = await (projectIds.length
    ? StageMeasurement.findAll({ where: { projectStageId: { [Op.in]: stages.map((s) => s.id) } }, transaction })
    : []);
  const measurementsByStatus = measurements.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {});

  // --- Painel "Pós-obra" (garantia/pós-entrega — TODAS as obras, não só uma) ---
  const warrantyCases = projectIds.length
    ? await MaintenanceCase.findAll({ where: { projectId: { [Op.in]: projectIds } }, transaction })
    : [];
  const warrantyCaseIds = warrantyCases.map((c) => c.id);
  const warrantyActions = warrantyCaseIds.length
    ? await WarrantyAction.findAll({ where: { warrantyCaseId: { [Op.in]: warrantyCaseIds } }, transaction })
    : [];

  const openWarrantyCases = warrantyCases.filter((c) => c.status !== 'CLOSED');
  const closedWarrantyCases = warrantyCases.filter((c) => c.status === 'CLOSED');
  const warrantyCasesByEscalationLevel = warrantyCases.reduce(
    (acc, c) => {
      const level = c.escalationLevel || 'NONE';
      acc[level] = (acc[level] || 0) + 1;
      return acc;
    },
    { NONE: 0, WARNING: 0, CRITICAL: 0, OVERDUE: 0 }
  );

  const postObraLaborCost = warrantyCases.reduce((acc, c) => acc + toNumber(c.laborCost), 0) + warrantyActions.reduce((acc, a) => acc + toNumber(a.cost), 0);
  const postObraMaterialCost = warrantyCases.reduce((acc, c) => acc + toNumber(c.materialCost), 0);
  const postObraTotalCost = round2(postObraLaborCost + postObraMaterialCost);

  // Recorrência por causa (rootCauseCode do chamado de garantia) — KPI "recorrência por causa/
  // equipe/material" exigido pelo caderno de BI (seção 9). Equipe/material específico de ação
  // de garantia não tem campo dedicado no schema atual (lacuna documental, não inventada aqui).
  const recurrenceByRootCause = Object.entries(
    warrantyCases.reduce((acc, c) => {
      const key = c.rootCauseCode || 'DESCONHECIDA';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  )
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count);

  return {
    obras: {
      totalProjects: projects.length,
      projectsInProgress: projects.filter((p) => !DELIVERED_LIKE_STATUSES.includes(p.status) && p.status !== 'CANCELLED').length,
      projectsByStatus,
      overdueProjectsCount: overdueProjects.length,
      avgPhysicalProgressPct,
      avgPlannedProgressPct,
      baselineBudgetTotal: round2(baselineBudgetTotal),
      approvedChangesTotal: round2(approvedChangesTotal),
      committedCostTotal: round2(committedCostTotal),
      actualFinancialCostTotal: round2(actualFinancialCostTotal),
      forecastToCompleteTotal: round2(forecastToCompleteTotal),
      projectedTotalCostTotal,
      projectedMarginTotal,
      projectedMarginPct,
      measurementsByStatus,
      openNonconformities,
      wastagePct,
    },
    posObra: {
      totalCases: warrantyCases.length,
      openCases: openWarrantyCases.length,
      closedCases: closedWarrantyCases.length,
      casesByEscalationLevel: warrantyCasesByEscalationLevel,
      totalLaborCost: round2(postObraLaborCost),
      totalMaterialCost: round2(postObraMaterialCost),
      totalWarrantyCost: postObraTotalCost,
      recurrenceByRootCause,
    },
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getConstructionDashboard };
