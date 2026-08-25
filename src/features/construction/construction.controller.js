'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const projectsService = require('./projects.service');
const projectStagesService = require('./projectStages.service');
const stageMeasurementsService = require('./stageMeasurements.service');
const dailyReportsService = require('./dailyReports.service');
const budgetLinesService = require('./budgetLines.service');
const qualityChecklistService = require('./qualityChecklist.service');
const maintenanceCasesService = require('./maintenanceCases.service');

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
const updateProjectStage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    projectStagesService.updateProjectStage(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
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

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  transitionProject,
  removeProject,
  createProjectStage,
  listProjectStages,
  getProjectStage,
  updateProjectStage,
  createStageMeasurement,
  listStageMeasurements,
  decideStageMeasurement,
  createDailyReport,
  listDailyReports,
  getDailyReport,
  updateDailyReport,
  createBudgetLine,
  listBudgetLines,
  updateBudgetLine,
  createQualityItem,
  listQualityItems,
  checkQualityItem,
  createMaintenanceCase,
  listMaintenanceCases,
  getMaintenanceCase,
  updateMaintenanceCase,
  removeMaintenanceCase,
};
