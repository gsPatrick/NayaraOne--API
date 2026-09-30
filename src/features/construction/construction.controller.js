'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const projectsService = require('./projects.service');
const projectHealthService = require('./projectHealth.service');
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
const updateDailyReport = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    dailyReportsService.updateDailyReport(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
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
const upsertApprovalThreshold = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    lossRecordsService.upsertApprovalThreshold(withTenant(req), req.auth.userId, t)
  );
  return success(res, { data: item });
});

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  transitionProject,
  removeProject,
  getProjectHealth,
  createProjectStage,
  listProjectStages,
  getProjectStage,
  updateProjectStage,
  createStageDependency,
  listStageDependencies,
  createStageMeasurement,
  listStageMeasurements,
  submitStageMeasurement,
  reviewStageMeasurement,
  reviseStageMeasurement,
  listMeasurementItems,
  decideStageMeasurement,
  createDailyReport,
  listDailyReports,
  getDailyReport,
  updateDailyReport,
  createBudgetLine,
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
  upsertApprovalThreshold,
};
