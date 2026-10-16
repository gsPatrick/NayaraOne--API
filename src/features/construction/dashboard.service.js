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
  InventoryMovement,
  InventoryItem,
} = require('../../models');
const { getTeamAndMaterialByActionIds } = require('./warrantyActionTeamMaterialColumns');

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

  // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 5, Frente C, 09/10/2026): este agregado
  // calculava forecastToComplete/projectedTotalCost/projectedMargin SEM consumedInventoryCost,
  // diferente da fórmula canônica em projectHealth.service.js#computeMarginProjection (que soma
  // actualFinancialCost + consumedInventoryCost em realizedCost). Para qualquer obra com consumo
  // de estoque real, o painel agregado (Centro de Comando) subestimava o custo total e inflava
  // a margem projetada exibida, divergindo do drill-down por obra (getProjectHealth) — viés
  // sistemático de ocultar prejuízo por consumo de estoque no agregado.
  const inventoryMovements = projectIds.length
    ? await InventoryMovement.findAll({ where: { projectId: { [Op.in]: projectIds }, movementType: { [Op.in]: ['OUT', 'RETURN'] } }, transaction })
    : [];
  const inventoryItemIds = [...new Set(inventoryMovements.map((m) => m.inventoryItemId))];
  const inventoryItems = inventoryItemIds.length
    ? await InventoryItem.findAll({ where: { id: { [Op.in]: inventoryItemIds } }, transaction })
    : [];
  const inventoryCostById = new Map(inventoryItems.map((i) => [i.id, toNumber(i.averageCost)]));
  const consumedInventoryCostTotal = inventoryMovements.reduce((acc, m) => {
    const unitCost = inventoryCostById.get(m.inventoryItemId) || 0;
    const sign = m.movementType === 'RETURN' ? -1 : 1;
    return acc + sign * toNumber(m.quantity) * unitCost;
  }, 0);

  const realizedCostTotal = actualFinancialCostTotal + consumedInventoryCostTotal;
  const marginBudgetBaseTotal = committedCostTotal + approvedChangesTotal;

  // BUG REAL CORRIGIDO (auditoria externa Nayara/ChatGPT, reteste 10/10/2026 — F2, estendido ao
  // agregado pra não reabrir a divergência já corrigida no Ciclo 5): a fórmula canônica em
  // projectHealth.service.js#computeMarginProjection passou a usar EAC (Estimate At Completion)
  // por desempenho de custo POR OBRA quando há progresso físico medido — permite margem
  // positiva, não mais travada em <= 0 (ver comentário detalhado lá). Esse agregado somava
  // forecastToComplete/projectedTotalCost em nível de EMPRESA com a fórmula antiga (sempre
  // assume gastar o resto do orçamento), que reintroduziria exatamente a mesma divergência
  // dashboard-vs-drilldown já corrigida no Ciclo 5 — a margem agregada nunca poderia ficar
  // positiva mesmo que toda obra individual mostrasse economia real. Calcula o EAC POR OBRA
  // (não dá pra fazer isso só com somas globais, porque a taxa de desempenho de custo é por
  // obra) e soma os resultados — mesma fórmula, nunca duplicada em espírito, só precisa ser
  // aplicada por obra antes de agregar.
  const budgetLinesByProject = new Map();
  for (const l of budgetLines) budgetLinesByProject.set(l.projectId, (budgetLinesByProject.get(l.projectId) || 0) + toNumber(l.plannedAmount));
  const changeOrdersByProject = new Map();
  for (const c of changeOrders) changeOrdersByProject.set(c.projectId, (changeOrdersByProject.get(c.projectId) || 0) + toNumber(c.budgetImpact));
  const actualCostByProject = new Map();
  for (const e of settledEntries) actualCostByProject.set(e.constructionProjectId, (actualCostByProject.get(e.constructionProjectId) || 0) + toNumber(e.amount));
  const inventoryCostByProject = new Map();
  for (const m of inventoryMovements) {
    const unitCost = inventoryCostById.get(m.inventoryItemId) || 0;
    const sign = m.movementType === 'RETURN' ? -1 : 1;
    inventoryCostByProject.set(m.projectId, (inventoryCostByProject.get(m.projectId) || 0) + sign * toNumber(m.quantity) * unitCost);
  }
  const stagesByProject = new Map();
  for (const s of stages) {
    if (!stagesByProject.has(s.projectId)) stagesByProject.set(s.projectId, []);
    stagesByProject.get(s.projectId).push(s);
  }

  let forecastToCompleteTotal = 0;
  let projectedTotalCostTotal = 0;
  for (const projectId of projectIds) {
    const projectBudgetBase = (budgetLinesByProject.get(projectId) || 0) + (changeOrdersByProject.get(projectId) || 0);
    const projectRealizedCost = (actualCostByProject.get(projectId) || 0) + (inventoryCostByProject.get(projectId) || 0);
    const projectStages = stagesByProject.get(projectId) || [];
    const projectPhysicalProgressPct = projectStages.length
      ? projectStages.reduce((acc, s) => acc + toNumber(s.measuredPct), 0) / projectStages.length
      : 0;

    let projectForecastToComplete;
    let projectProjectedTotalCost;
    if (projectPhysicalProgressPct > 0) {
      const estimateAtCompletion = projectRealizedCost / (projectPhysicalProgressPct / 100);
      projectForecastToComplete = Math.max(estimateAtCompletion - projectRealizedCost, 0);
      projectProjectedTotalCost = estimateAtCompletion;
    } else {
      projectForecastToComplete = Math.max(projectBudgetBase - projectRealizedCost, 0);
      projectProjectedTotalCost = projectRealizedCost + projectForecastToComplete;
    }
    forecastToCompleteTotal += projectForecastToComplete;
    projectedTotalCostTotal += projectProjectedTotalCost;
  }
  forecastToCompleteTotal = round2(forecastToCompleteTotal);
  projectedTotalCostTotal = round2(projectedTotalCostTotal);
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
  // equipe/material" exigido pelo caderno de BI (seção 9).
  const recurrenceByRootCause = Object.entries(
    warrantyCases.reduce((acc, c) => {
      const key = c.rootCauseCode || 'DESCONHECIDA';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  )
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count);

  // GAP CORRIGIDO (auditoria pós-Marco 6, item 2): equipe/material agora têm coluna dedicada em
  // `construction.warranty_actions` (`assigned_team`/`material_used`, migration
  // 20260101000296, pendente de aplicação por credencial de admin — ver
  // warrantyActionTeamMaterialColumns.js). Recorrência contada por AÇÃO de garantia (não por
  // chamado, já que é nela que mora equipe/material), igual critério já usado pra causa. Antes
  // da migration ser aplicada, o map vem vazio (fail-open) e os dois campos ficam `[]`.
  const teamMaterialByActionId = await getTeamAndMaterialByActionIds(warrantyActions.map((a) => a.id), transaction);
  const recurrenceByTeam = Object.entries(
    warrantyActions.reduce((acc, a) => {
      const key = teamMaterialByActionId.get(a.id)?.assignedTeam || 'DESCONHECIDA';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  )
    .map(([team, count]) => ({ team, count }))
    .sort((a, b) => b.count - a.count);

  const recurrenceByMaterial = Object.entries(
    warrantyActions.reduce((acc, a) => {
      const key = teamMaterialByActionId.get(a.id)?.materialUsed || 'DESCONHECIDA';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  )
    .map(([material, count]) => ({ material, count }))
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
      consumedInventoryCostTotal: round2(consumedInventoryCostTotal),
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
      recurrenceByTeam,
      recurrenceByMaterial,
    },
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getConstructionDashboard };
