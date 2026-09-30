'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const constructionController = require('./construction.controller');

const constructionRouter = Router();

constructionRouter.use(authMiddleware, tenantMiddleware);

// Projects (obras)
constructionRouter.post('/construction/projects', requirePermission('construction:create'), constructionController.createProject);
constructionRouter.get('/construction/projects', requirePermission('construction:read'), constructionController.listProjects);
constructionRouter.get('/construction/projects/:id', requirePermission('construction:read'), constructionController.getProject);
constructionRouter.patch('/construction/projects/:id', requirePermission('construction:update'), constructionController.updateProject);
constructionRouter.post('/construction/projects/:id/transition', requirePermission('construction:update'), constructionController.transitionProject);
constructionRouter.delete('/construction/projects/:id', requirePermission('construction:delete'), constructionController.removeProject);

// Project stages
constructionRouter.post('/construction/projects/:id/stages', requirePermission('construction:create'), constructionController.createProjectStage);
constructionRouter.get('/construction/projects/:id/stages', requirePermission('construction:read'), constructionController.listProjectStages);
constructionRouter.get('/construction/stages/:id', requirePermission('construction:read'), constructionController.getProjectStage);
constructionRouter.patch('/construction/stages/:id', requirePermission('construction:update'), constructionController.updateProjectStage);

// Stage dependencies (M6-03/M6-19/M6-56 — sem ciclo)
constructionRouter.post('/construction/stages/:id/dependencies', requirePermission('construction:create'), constructionController.createStageDependency);
constructionRouter.get('/construction/stages/:id/dependencies', requirePermission('construction:read'), constructionController.listStageDependencies);

// Stage measurements (aprovação exige permissão dedicada — mesmo padrão de finance:approve/legal:approve)
constructionRouter.post('/construction/stages/:id/measurements', requirePermission('construction:create'), constructionController.createStageMeasurement);
constructionRouter.get('/construction/stages/:id/measurements', requirePermission('construction:read'), constructionController.listStageMeasurements);
constructionRouter.post('/construction/measurements/:id/decide', requirePermission('construction:approve'), constructionController.decideStageMeasurement);

// Daily reports (RDO)
constructionRouter.post('/construction/projects/:id/daily-reports', requirePermission('construction:create'), constructionController.createDailyReport);
constructionRouter.get('/construction/projects/:id/daily-reports', requirePermission('construction:read'), constructionController.listDailyReports);
constructionRouter.get('/construction/daily-reports/:id', requirePermission('construction:read'), constructionController.getDailyReport);
constructionRouter.patch('/construction/daily-reports/:id', requirePermission('construction:update'), constructionController.updateDailyReport);

// Budget lines (orçamento/custos)
constructionRouter.post('/construction/projects/:id/budget-lines', requirePermission('construction:create'), constructionController.createBudgetLine);
constructionRouter.get('/construction/projects/:id/budget-lines', requirePermission('construction:read'), constructionController.listBudgetLines);
constructionRouter.patch('/construction/budget-lines/:id', requirePermission('construction:update'), constructionController.updateBudgetLine);

// Budgets (orçamento agregado / baseline / aprovação — M6-04/M6-17/M6-31/M6-32)
constructionRouter.post('/construction/projects/:id/budgets', requirePermission('construction:create'), constructionController.createBudget);
constructionRouter.get('/construction/projects/:id/budgets', requirePermission('construction:read'), constructionController.listBudgets);
constructionRouter.get('/construction/budgets/:id', requirePermission('construction:read'), constructionController.getBudget);
constructionRouter.post('/construction/budgets/:id/approve', requirePermission('construction:approve'), constructionController.approveBudget);

// Change Orders (M6-06/M6-33)
constructionRouter.post('/construction/projects/:id/change-orders', requirePermission('construction:create'), constructionController.createChangeOrder);
constructionRouter.get('/construction/projects/:id/change-orders', requirePermission('construction:read'), constructionController.listChangeOrders);
constructionRouter.post('/construction/change-orders/:id/decide', requirePermission('construction:approve'), constructionController.decideChangeOrder);

// Quality checklist
constructionRouter.post('/construction/projects/:id/quality-items', requirePermission('construction:create'), constructionController.createQualityItem);
constructionRouter.get('/construction/projects/:id/quality-items', requirePermission('construction:read'), constructionController.listQualityItems);
constructionRouter.post('/construction/quality-items/:id/check', requirePermission('construction:update'), constructionController.checkQualityItem);

// Maintenance cases (pós-obra/garantia)
constructionRouter.post('/construction/maintenance-cases', requirePermission('construction:create'), constructionController.createMaintenanceCase);
constructionRouter.get('/construction/maintenance-cases', requirePermission('construction:read'), constructionController.listMaintenanceCases);
constructionRouter.get('/construction/maintenance-cases/:id', requirePermission('construction:read'), constructionController.getMaintenanceCase);
constructionRouter.patch('/construction/maintenance-cases/:id', requirePermission('construction:update'), constructionController.updateMaintenanceCase);
constructionRouter.delete('/construction/maintenance-cases/:id', requirePermission('construction:delete'), constructionController.removeMaintenanceCase);

module.exports = constructionRouter;
