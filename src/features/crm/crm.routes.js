'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const crmController = require('./crm.controller');

const crmRouter = Router();

crmRouter.use(authMiddleware, tenantMiddleware);

// M3-21 — exportação sensível: permissão DEDICADA (não basta crm:opportunities:read) e
// sempre auditada. Precisa vir ANTES de '/opportunities/:id' para não ser capturada por ele.
crmRouter.get(
  '/crm/opportunities/export',
  requirePermission('crm:opportunities:export'),
  crmController.exportOpportunities
);

// --- Propostas (M3-13 / M3-25) ---
crmRouter.post('/crm/proposals', requirePermission('crm:proposals:create'), crmController.createProposal);
crmRouter.get('/crm/proposals', requirePermission('crm:proposals:read'), crmController.listProposals);
crmRouter.get('/crm/proposals/:id', requirePermission('crm:proposals:read'), crmController.getProposal);
crmRouter.patch('/crm/proposals/:id/status', requirePermission('crm:proposals:update'), crmController.updateProposalStatus);

// --- Painel de indicadores (M3-17) ---
crmRouter.get('/crm/dashboard', requirePermission('crm:dashboard:read'), crmController.getDashboard);

// --- Reclamações, elogios e conflitos (M3-20) ---
crmRouter.post('/crm/feedback-cases', requirePermission('crm:feedback:create'), crmController.createFeedbackCase);
crmRouter.get('/crm/feedback-cases', requirePermission('crm:feedback:read'), crmController.listFeedbackCases);
crmRouter.get('/crm/feedback-cases/:id', requirePermission('crm:feedback:read'), crmController.getFeedbackCase);
crmRouter.patch('/crm/feedback-cases/:id/resolve', requirePermission('crm:feedback:update'), crmController.resolveFeedbackCase);
crmRouter.patch('/crm/feedback-cases/:id/escalate', requirePermission('crm:feedback:update'), crmController.escalateFeedbackCase);

crmRouter.post('/opportunities', requirePermission('crm:opportunities:create'), crmController.createOpportunity);
crmRouter.get('/opportunities', requirePermission('crm:opportunities:read'), crmController.listOpportunities);
crmRouter.get('/opportunities/:id', requirePermission('crm:opportunities:read'), crmController.getOpportunity);
crmRouter.patch('/opportunities/:id', requirePermission('crm:opportunities:update'), crmController.updateOpportunity);
crmRouter.delete('/opportunities/:id', requirePermission('crm:opportunities:delete'), crmController.removeOpportunity);

crmRouter.post('/visits', requirePermission('crm:visits:create'), crmController.createVisit);
crmRouter.get('/visits', requirePermission('crm:visits:read'), crmController.listVisits);
crmRouter.get('/visits/:id', requirePermission('crm:visits:read'), crmController.getVisit);
crmRouter.patch('/visits/:id', requirePermission('crm:visits:update'), crmController.updateVisit);
crmRouter.delete('/visits/:id', requirePermission('crm:visits:delete'), crmController.removeVisit);

crmRouter.post('/messages', requirePermission('crm:messages:create'), crmController.createMessage);
crmRouter.get('/messages', requirePermission('crm:messages:read'), crmController.listMessages);
crmRouter.get('/messages/:id', requirePermission('crm:messages:read'), crmController.getMessage);
crmRouter.patch('/messages/:id/status', requirePermission('crm:messages:update'), crmController.updateMessageStatus);

module.exports = crmRouter;
