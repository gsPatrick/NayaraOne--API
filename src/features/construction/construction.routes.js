'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const constructionController = require('./construction.controller');

const constructionRouter = Router();

constructionRouter.use(authMiddleware, tenantMiddleware);

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): painéis "Obras"/"Pós-obra" agregados de TODAS
// as obras — rota declarada ANTES de "/construction/projects/:id" pra "dashboard" nunca ser
// capturado pelo parâmetro :id de rota dinâmica (mesmo cuidado de ordenação já usado pra
// "/construction/projects/:id/health" etc, que são sub-rotas, não conflitam).
// Reaproveita a permissão "construction:read" já existente/concedida aos papéis — uma permissão
// nova ("construction:dashboard:read", espelhando crm:dashboard:read) exigiria seed de migration
// pra ser concedida a algum papel, e este ambiente de execução não tem acesso para rodar
// migrations contra o banco compartilhado (ver limitação documentada em marginRules.service.js).
constructionRouter.get('/construction/dashboard', requirePermission('construction:read'), constructionController.getConstructionDashboard);

// Projects (obras)
constructionRouter.post('/construction/projects', requirePermission('construction:create'), constructionController.createProject);
constructionRouter.get('/construction/projects', requirePermission('construction:read'), constructionController.listProjects);
constructionRouter.get('/construction/projects/:id', requirePermission('construction:read'), constructionController.getProject);
constructionRouter.patch('/construction/projects/:id', requirePermission('construction:update'), constructionController.updateProject);
constructionRouter.post('/construction/projects/:id/transition', requirePermission('construction:update'), constructionController.transitionProject);
// Gate de entrega da obra (M6-25/M6-39/M6-51/M6-65/M6-79/M6-87) — permissão dedicada de
// aprovação, mesmo padrão de `/construction/measurements/:id/decide`.
constructionRouter.post('/construction/projects/:id/deliver', requirePermission('construction:approve'), constructionController.deliverProject);
constructionRouter.post('/construction/projects/:id/close-warranty', requirePermission('construction:approve'), constructionController.closeProjectWarranty);
constructionRouter.delete('/construction/projects/:id', requirePermission('construction:delete'), constructionController.removeProject);
// M6-42/M6-99 — read model de custo/KPIs da obra.
constructionRouter.get('/construction/projects/:id/health', requirePermission('construction:read'), constructionController.getProjectHealth);
constructionRouter.get('/construction/projects/:id/post-obra-health', requirePermission('construction:read'), constructionController.getPostObraHealth);
// M6-101: NAY Obras — componente nomeado de resumo determinístico (nunca decide, M6-27).
constructionRouter.get('/construction/projects/:id/nay-summary', requirePermission('construction:read'), constructionController.getNayObrasSummary);
constructionRouter.get('/construction/projects/:id/nay-summary/post-obra', requirePermission('construction:read'), constructionController.getNayObrasPostObraSummary);

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
constructionRouter.get('/construction/measurements/:id/items', requirePermission('construction:read'), constructionController.listMeasurementItems);
constructionRouter.post('/construction/measurements/:id/submit', requirePermission('construction:create'), constructionController.submitStageMeasurement);
constructionRouter.post('/construction/measurements/:id/review', requirePermission('construction:update'), constructionController.reviewStageMeasurement);
constructionRouter.post('/construction/measurements/:id/revise', requirePermission('construction:create'), constructionController.reviseStageMeasurement);
constructionRouter.post('/construction/measurements/:id/decide', requirePermission('construction:approve'), constructionController.decideStageMeasurement);
// M6-35: path canônico exigido pela fonte ("POST /projects/:id/measurements") — cria a medição
// vinculada à etapa informada em `projectStageId` no corpo, mesmo comportamento/controller de
// `POST /construction/stages/:id/measurements` acima.
constructionRouter.post(
  '/construction/projects/:id/measurements',
  requirePermission('construction:create'),
  constructionController.createStageMeasurementByProject
);
// M6-36: path canônico exigido pela fonte ("POST /measurements/:id/approve") — SÓ aprova (não
// aceita rejeitar, diferente de `/decide` acima, que cobre os dois); nome do endpoint bate
// literalmente com o verbo que ele executa.
constructionRouter.post(
  '/construction/measurements/:id/approve',
  requirePermission('construction:approve'),
  constructionController.approveStageMeasurement
);

// Daily reports (RDO)
constructionRouter.post('/construction/projects/:id/daily-reports', requirePermission('construction:create'), constructionController.createDailyReport);
// M6-34: path canônico exigido pela fonte ("POST /projects/:id/daily-logs"), mesmo controller.
constructionRouter.post('/construction/projects/:id/daily-logs', requirePermission('construction:create'), constructionController.createDailyReport);
constructionRouter.get('/construction/projects/:id/daily-reports', requirePermission('construction:read'), constructionController.listDailyReports);
constructionRouter.get('/construction/daily-reports/:id', requirePermission('construction:read'), constructionController.getDailyReport);
constructionRouter.get('/construction/daily-reports/:id/history', requirePermission('construction:read'), constructionController.getDailyReportHistory);
constructionRouter.patch('/construction/daily-reports/:id', requirePermission('construction:update'), constructionController.updateDailyReport);
constructionRouter.get('/construction/daily-reports/:id/workers', requirePermission('construction:read'), constructionController.listDailyWorkers);
constructionRouter.get('/construction/daily-reports/:id/materials', requirePermission('construction:read'), constructionController.listDailyMaterials);

// Budget lines (orçamento/custos)
constructionRouter.post('/construction/projects/:id/budget-lines', requirePermission('construction:create'), constructionController.createBudgetLine);
constructionRouter.get('/construction/projects/:id/budget-lines', requirePermission('construction:read'), constructionController.listBudgetLines);
constructionRouter.patch('/construction/budget-lines/:id', requirePermission('construction:update'), constructionController.updateBudgetLine);
constructionRouter.delete('/construction/budget-lines/:id', requirePermission('construction:update'), constructionController.removeBudgetLine);

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
constructionRouter.delete('/construction/quality-items/:id', requirePermission('construction:update'), constructionController.removeQualityItem);

// Nonconformities (não conformidades)
constructionRouter.post('/construction/projects/:id/nonconformities', requirePermission('construction:create'), constructionController.createNonconformity);
constructionRouter.get('/construction/projects/:id/nonconformities', requirePermission('construction:read'), constructionController.listNonconformities);
constructionRouter.get('/construction/nonconformities/:id', requirePermission('construction:read'), constructionController.getNonconformity);
constructionRouter.post('/construction/nonconformities/:id/close', requirePermission('construction:update'), constructionController.closeNonconformity);

// Loss records (perda de material por alçada)
constructionRouter.post('/construction/projects/:id/loss-records', requirePermission('construction:create'), constructionController.createLossRecord);
constructionRouter.get('/construction/projects/:id/loss-records', requirePermission('construction:read'), constructionController.listLossRecords);
constructionRouter.post('/construction/loss-records/:id/approve', requirePermission('construction:approve'), constructionController.approveLossRecord);
constructionRouter.post('/construction/loss-records/:id/return', requirePermission('construction:update'), constructionController.returnLossRecord);
constructionRouter.post('/construction/approval-thresholds', requirePermission('construction:update'), constructionController.upsertApprovalThreshold);

// Margem mínima de obra (MarginRule) — pré-requisito pra approveBudget conseguir aprovar
// QUALQUER orçamento (bug crítico achado numa auditoria do Front: nunca teve endpoint).
constructionRouter.post('/construction/margin-rules', requirePermission('construction:update'), constructionController.createMarginRule);
constructionRouter.get('/construction/margin-rules/active', requirePermission('construction:read'), constructionController.getActiveMarginRule);

// Maintenance cases (pós-obra/garantia)
constructionRouter.post('/construction/maintenance-cases', requirePermission('construction:create'), constructionController.createMaintenanceCase);
// M6-40: path canônico exigido pela fonte ("POST /warranty-cases"), mesmo controller/entidade
// (`MaintenanceCase` já é o WarrantyCase estruturado, M6-15/M6-26).
constructionRouter.post('/construction/warranty-cases', requirePermission('construction:create'), constructionController.createMaintenanceCase);
constructionRouter.get('/construction/maintenance-cases', requirePermission('construction:read'), constructionController.listMaintenanceCases);
constructionRouter.get('/construction/maintenance-cases/:id', requirePermission('construction:read'), constructionController.getMaintenanceCase);
constructionRouter.patch('/construction/maintenance-cases/:id', requirePermission('construction:update'), constructionController.updateMaintenanceCase);
constructionRouter.delete('/construction/maintenance-cases/:id', requirePermission('construction:delete'), constructionController.removeMaintenanceCase);

// Warranty actions (histórico de atendimento dentro do chamado de garantia)
constructionRouter.post(
  '/construction/maintenance-cases/:id/actions',
  requirePermission('construction:update'),
  constructionController.createWarrantyAction
);
constructionRouter.get(
  '/construction/maintenance-cases/:id/actions',
  requirePermission('construction:read'),
  constructionController.listWarrantyActions
);

// Desconto/ressarcimento de garantia (regra/aprovação + Financeiro)
constructionRouter.post(
  '/construction/maintenance-cases/:id/resolution',
  requirePermission('construction:update'),
  constructionController.proposeWarrantyResolution
);
// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 36, 2026-10-05): essa rota exigia
// só 'construction:update' (risco MEDIUM, edição comum) para uma ação que aprova resolução de
// garantia ACIMA da alçada e dispara lançamento financeiro real (DEBIT/PAYABLE) — mesmo padrão
// de todas as outras rotas de aprovação deste arquivo (deliver, close-warranty, measurements
// decide/approve, budgets approve, change-orders decide, loss-records approve), que usam
// 'construction:approve' (risco HIGH). Quebrava o princípio de menor privilégio.
constructionRouter.post(
  '/construction/maintenance-cases/:id/resolution/approve',
  requirePermission('construction:approve'),
  constructionController.approveWarrantyResolution
);

// Material requests (M6-28) — mínimo exigido para o Marco 6, integração completa com
// Estoque/Patrimônio é escopo do Marco 7 (ver materialRequests.service.js).
constructionRouter.post('/construction/projects/:id/material-requests', requirePermission('construction:create'), constructionController.createMaterialRequest);
constructionRouter.get('/construction/projects/:id/material-requests', requirePermission('construction:read'), constructionController.listMaterialRequests);
constructionRouter.post('/construction/material-requests/:id/receive', requirePermission('construction:update'), constructionController.receiveMaterialRequest);

module.exports = constructionRouter;
