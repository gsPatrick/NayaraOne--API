'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const crmController = require('./crm.controller');

const crmRouter = Router();

crmRouter.use(authMiddleware, tenantMiddleware);

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
