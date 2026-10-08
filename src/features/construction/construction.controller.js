'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const projectsService = require('./projects.service');
const projectHealthService = require('./projectHealth.service');
const nayObrasService = require('./nayObras.service');
const postObraHealthService = require('./postObraHealth.service');
const projectStagesService = require('./projectStages.service');
const stageMeasurementsService = require('./stageMeasurements.service');
const stageDependenciesService = require('./stageDependencies.service');
const dailyReportsService = require('./dailyReports.service');
const budgetLinesService = require('./budgetLines.service');
const budgetsService = require('./budgets.service');
const changeOrdersService = require('./changeOrders.service');
const qualityChecklistService = require('./qualityChecklist.service');
const maintenanceCasesService = require('./maintenanceCases.service');
const nonconformitiesService = require('./nonconformities.service');
const lossRecordsService = require('./lossRecords.service');
const materialRequestsService = require('./materialRequests.service');
const marginRulesService = require('./marginRules.service');
const dashboardService = require('./dashboard.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

// --- Projects ---
const createProject = catchAsync(async (req, res) => {
  const project = await req.withTenantTransaction((t) => projectsService.createProject(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: project });
});
const listProjects = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    projectsService.listProjects(t, { status: req.query.status, propertyId: req.query.propertyId })
  );
  return success(res, { data: items });
});
const getProject = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => projectsService.getProject(req.params.id, t));
  return success(res, { data: item });
});
const updateProject = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => projectsService.updateProject(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const transitionProject = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    projectsService.transitionProject(req.params.id, req.body.targetStatus, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const removeProject = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => projectsService.removeProject(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const closeProjectWarranty = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => projectsService.closeProjectWarranty(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

const deliverProject = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => projectsService.deliverProject(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Project stages ---
const createProjectStage = catchAsync(async (req, res) => {
  const stage = await req.withTenantTransaction((t) =>
    projectStagesService.createProjectStage(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: stage });
});
const listProjectStages = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => projectStagesService.listProjectStages(req.params.id, t));
  return success(res, { data: items });
});
const getProjectStage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => projectStagesService.getProjectStage(req.params.id, t));
  return success(res, { data: item });
});
const getProjectHealth = catchAsync(async (req, res) => {
  const health = await req.withTenantTransaction((t) => projectHealthService.getProjectHealth(req.params.id, t));
  return success(res, { data: health });
});

const getPostObraHealth = catchAsync(async (req, res) => {
  const health = await req.withTenantTransaction((t) => postObraHealthService.getPostObraHealth(req.params.id, t));
  return success(res, { data: health });
});

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): painéis "Obras" e "Pós-obra" agregados de
// TODAS as obras da empresa (não uma obra específica) — ver dashboard.service.js.
const getConstructionDashboard = catchAsync(async (req, res) => {
  const dashboard = await req.withTenantTransaction((t) =>
    dashboardService.getConstructionDashboard({ groupId: req.auth.groupId, companyId: req.auth.companyId }, t)
  );
  return success(res, { data: dashboard });
});
// M6-101: componente "NAY Obras" nomeado — resumo determinístico, nunca decide nada (M6-27).
const getNayObrasSummary = catchAsync(async (req, res) => {
  const summary = await req.withTenantTransaction((t) => nayObrasService.summarizeProject(req.params.id, t));
  return success(res, { data: summary });
});
const getNayObrasPostObraSummary = catchAsync(async (req, res) => {
  const summary = await req.withTenantTransaction((t) => nayObrasService.summarizePostObra(req.params.id, t));
  return success(res, { data: summary });
});
const updateProjectStage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    projectStagesService.updateProjectStage(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Stage dependencies ---
const createStageDependency = catchAsync(async (req, res) => {
  const dependency = await req.withTenantTransaction((t) =>
    stageDependenciesService.createStageDependency(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: dependency });
});
const listStageDependencies = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => stageDependenciesService.listStageDependencies(req.params.id, t));
  return success(res, { data: items });
});

// --- Stage measurements ---
const createStageMeasurement = catchAsync(async (req, res) => {
  const measurement = await req.withTenantTransaction((t) =>
    stageMeasurementsService.createStageMeasurement(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: measurement });
});
// M6-35: path canônico "POST /projects/:id/measurements" — a etapa vem de `projectStageId` no
// corpo (o path da fonte é por obra, não por etapa); mesmo service de `createStageMeasurement`.
const createStageMeasurementByProject = catchAsync(async (req, res) => {
  const { projectStageId, ...rest } = req.body;
  if (!projectStageId) {
    throw AppError.badRequest('"projectStageId" é obrigatório.', 'STAGE_MEASUREMENT_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria HTTP real, item 6 — fechamento de gaps pós-Marco 6):
  // `withTenant(req)` lê `req.auth.groupId/companyId` — chamá-lo com `{ ...rest }` (um objeto
  // qualquer, não a requisição) estourava "Cannot read properties of undefined (reading
  // 'groupId')" porque `{ ...rest }.auth` é `undefined`. O path canônico
  // "POST /projects/:id/measurements" nunca tinha sido exercitado via HTTP real antes (só
  // via chamada direta ao service ou via /stages/:id/measurements), por isso o bug sobrevivia.
  const measurement = await req.withTenantTransaction((t) =>
    stageMeasurementsService.createStageMeasurement(
      projectStageId,
      { ...rest, groupId: req.auth.groupId, companyId: req.auth.companyId },
      req.auth.userId,
      t
    )
  );
  return success(res, { statusCode: 201, data: measurement });
});
const listStageMeasurements = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => stageMeasurementsService.listStageMeasurements(req.params.id, t));
  return success(res, { data: items });
});
const decideStageMeasurement = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    stageMeasurementsService.decideStageMeasurement(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
// M6-36: path canônico "POST /measurements/:id/approve" — SÓ aprova, o corpo da requisição
// nunca aceita "decision" (o nome do endpoint já é o verbo executado).
const approveStageMeasurement = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    stageMeasurementsService.decideStageMeasurement(req.params.id, { decision: 'APPROVED' }, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const submitStageMeasurement = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => stageMeasurementsService.submitStageMeasurement(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const reviewStageMeasurement = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    stageMeasurementsService.reviewStageMeasurement(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const reviseStageMeasurement = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    stageMeasurementsService.reviseStageMeasurement(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listMeasurementItems = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => stageMeasurementsService.listMeasurementItems(req.params.id, t));
  return success(res, { data: items });
});

// --- Daily reports (RDO) ---
const createDailyReport = catchAsync(async (req, res) => {
  const report = await req.withTenantTransaction((t) =>
    dailyReportsService.createDailyReport(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: report });
});
const listDailyReports = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => dailyReportsService.listDailyReports(req.params.id, t));
  return success(res, { data: items });
});
const getDailyReport = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => dailyReportsService.getDailyReport(req.params.id, t));
  return success(res, { data: item });
});
const getDailyReportHistory = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => dailyReportsService.getDailyReportHistory(req.params.id, t));
  return success(res, { data: items });
});
const updateDailyReport = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    dailyReportsService.updateDailyReport(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const listDailyWorkers = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => dailyReportsService.listDailyWorkers(req.params.id, t));
  return success(res, { data: items });
});
const listDailyMaterials = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => dailyReportsService.listDailyMaterials(req.params.id, t));
  return success(res, { data: items });
});

// --- Budget lines ---
const createBudgetLine = catchAsync(async (req, res) => {
  const line = await req.withTenantTransaction((t) =>
    budgetLinesService.createBudgetLine(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: line });
});
const listBudgetLines = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => budgetLinesService.listBudgetLines(req.params.id, t));
  return success(res, { data: items });
});
const updateBudgetLine = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    budgetLinesService.updateBudgetLine(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const removeBudgetLine = catchAsync(async (req, res) => {
  await req.withTenantTransaction((t) => budgetLinesService.removeBudgetLine(req.params.id, req.auth.userId, t));
  return success(res, { statusCode: 204, data: null });
});

// --- Budgets (orçamento agregado / baseline / aprovação) ---
const createBudget = catchAsync(async (req, res) => {
  const budget = await req.withTenantTransaction((t) => budgetsService.createBudget(req.params.id, withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: budget });
});
const listBudgets = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => budgetsService.listBudgets(req.params.id, t));
  return success(res, { data: items });
});
const getBudget = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => budgetsService.getBudget(req.params.id, t));
  return success(res, { data: item });
});
const approveBudget = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => budgetsService.approveBudget(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Change Orders ---
const createChangeOrder = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    changeOrdersService.createChangeOrder(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listChangeOrders = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => changeOrdersService.listChangeOrders(req.params.id, t));
  return success(res, { data: items });
});
const decideChangeOrder = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    changeOrdersService.decideChangeOrder(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Quality checklist ---
const createQualityItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    qualityChecklistService.createQualityItem(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listQualityItems = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => qualityChecklistService.listQualityItems(req.params.id, t));
  return success(res, { data: items });
});
const checkQualityItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    qualityChecklistService.checkQualityItem(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const removeQualityItem = catchAsync(async (req, res) => {
  await req.withTenantTransaction((t) => qualityChecklistService.removeQualityItem(req.params.id, req.auth.userId, t));
  return success(res, { statusCode: 204, data: null });
});

// --- Maintenance cases (pós-obra) ---
const createMaintenanceCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    maintenanceCasesService.createMaintenanceCase(withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listMaintenanceCases = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    maintenanceCasesService.listMaintenanceCases(t, { status: req.query.status, propertyId: req.query.propertyId, projectId: req.query.projectId })
  );
  return success(res, { data: items });
});
const getMaintenanceCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => maintenanceCasesService.getMaintenanceCase(req.params.id, t));
  return success(res, { data: item });
});
const updateMaintenanceCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    maintenanceCasesService.updateMaintenanceCase(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const removeMaintenanceCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    maintenanceCasesService.removeMaintenanceCase(req.params.id, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Nonconformities (não conformidades) ---
const createNonconformity = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    nonconformitiesService.createNonconformity(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listNonconformities = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    nonconformitiesService.listNonconformities(req.params.id, t, { status: req.query.status })
  );
  return success(res, { data: items });
});
const getNonconformity = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => nonconformitiesService.getNonconformity(req.params.id, t));
  return success(res, { data: item });
});
const closeNonconformity = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    nonconformitiesService.closeNonconformity(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Material requests (M6-28) ---
const createMaterialRequest = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    materialRequestsService.createMaterialRequest(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listMaterialRequests = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    materialRequestsService.listMaterialRequests(req.params.id, t, { status: req.query.status })
  );
  return success(res, { data: items });
});
const receiveMaterialRequest = catchAsync(async (req, res) => {
  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07): item/local do Estoque agora são
  // obrigatórios pra confirmar o recebimento — ver materialRequests.service.js.
  const { inventoryItemId, sourceLocationId } = req.body || {};
  const item = await req.withTenantTransaction((t) =>
    materialRequestsService.receiveMaterialRequest(req.params.id, req.auth.userId, t, { inventoryItemId, sourceLocationId })
  );
  return success(res, { data: item });
});
const returnMaterialRequest = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    materialRequestsService.returnMaterialRequest(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: result });
});

// --- Loss records (perda de material) ---
const createLossRecord = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    lossRecordsService.createLossRecord(req.params.id, withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listLossRecords = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    lossRecordsService.listLossRecords(req.params.id, t, { status: req.query.status })
  );
  return success(res, { data: items });
});
const approveLossRecord = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => lossRecordsService.approveLossRecord(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const returnLossRecord = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    lossRecordsService.returnLossRecord(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
// --- Margem mínima de obra (MarginRule) — achado numa auditoria do Front do Marco 6:
// createMarginRule/getActiveMarginRule NUNCA tiveram endpoint (só eram chamadas direto em
// teste). Sem isso, NENHUMA empresa real conseguia aprovar orçamento algum: approveBudget
// exige uma margem mínima ativa configurada e não havia como configurá-la a não ser inserindo
// a linha direto no banco. ---
const createMarginRule = catchAsync(async (req, res) => {
  const rule = await req.withTenantTransaction((t) => marginRulesService.createMarginRule(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: rule });
});
// Achado numa auditoria final do Front do Marco 6 (30/09/2026): esta tela chama este GET a cada
// carregamento de página pra saber se já existe margem configurada — "ainda não configurada" é
// um estado NORMAL aqui (bem diferente de dentro de approveBudget, onde a ausência é
// propositalmente fail-closed e vira 422/MARGIN_RULE_NOT_CONFIGURED). Devolver 422 nesta tela
// de consulta simples poluía o console/log com "erro" em toda carga de página comum. Devolve
// 200 com data:null quando não há regra ativa, sem alterar o comportamento de
// marginRulesService.getActiveMarginRule() usado internamente por approveBudget (que continua
// lançando, de propósito).
const getActiveMarginRule = catchAsync(async (req, res) => {
  const rule = await req
    .withTenantTransaction((t) => marginRulesService.getActiveMarginRule(req.auth.groupId, req.auth.companyId, t))
    .catch((err) => {
      if (err?.code === 'MARGIN_RULE_NOT_CONFIGURED') return null;
      throw err;
    });
  return success(res, { data: rule });
});

const upsertApprovalThreshold = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    lossRecordsService.upsertApprovalThreshold(withTenant(req), req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Warranty actions (histórico de atendimento dentro do chamado de garantia) ---
const createWarrantyAction = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    maintenanceCasesService.createWarrantyAction(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listWarrantyActions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => maintenanceCasesService.listWarrantyActions(req.params.id, t));
  return success(res, { data: items });
});

// --- Desconto/ressarcimento de garantia (regra/aprovação + Financeiro) ---
const proposeWarrantyResolution = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    maintenanceCasesService.proposeWarrantyResolution(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const approveWarrantyResolution = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    maintenanceCasesService.approveWarrantyResolution(req.params.id, req.auth.userId, t)
  );
  return success(res, { data: item });
});

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  transitionProject,
  deliverProject,
  closeProjectWarranty,
  removeProject,
  getProjectHealth,
  getPostObraHealth,
  getConstructionDashboard,
  getNayObrasSummary,
  getNayObrasPostObraSummary,
  createProjectStage,
  listProjectStages,
  getProjectStage,
  updateProjectStage,
  createStageDependency,
  listStageDependencies,
  createStageMeasurement,
  createStageMeasurementByProject,
  listStageMeasurements,
  submitStageMeasurement,
  reviewStageMeasurement,
  reviseStageMeasurement,
  listMeasurementItems,
  decideStageMeasurement,
  approveStageMeasurement,
  createDailyReport,
  listDailyReports,
  getDailyReport,
  getDailyReportHistory,
  updateDailyReport,
  listDailyWorkers,
  listDailyMaterials,
  createBudgetLine,
  removeBudgetLine,
  listBudgetLines,
  updateBudgetLine,
  createBudget,
  listBudgets,
  getBudget,
  approveBudget,
  createChangeOrder,
  listChangeOrders,
  decideChangeOrder,
  createQualityItem,
  removeQualityItem,
  listQualityItems,
  checkQualityItem,
  createMaintenanceCase,
  listMaintenanceCases,
  getMaintenanceCase,
  updateMaintenanceCase,
  removeMaintenanceCase,
  createNonconformity,
  listNonconformities,
  getNonconformity,
  closeNonconformity,
  createLossRecord,
  listLossRecords,
  approveLossRecord,
  returnLossRecord,
  createMarginRule,
  getActiveMarginRule,
  upsertApprovalThreshold,
  createWarrantyAction,
  listWarrantyActions,
  proposeWarrantyResolution,
  approveWarrantyResolution,
  createMaterialRequest,
  listMaterialRequests,
  receiveMaterialRequest,
  returnMaterialRequest,
};
