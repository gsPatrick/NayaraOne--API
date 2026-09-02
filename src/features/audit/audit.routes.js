'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const auditController = require('./audit.controller');

const auditRouter = Router();

auditRouter.use(authMiddleware, tenantMiddleware);

auditRouter.get('/audit-log', requirePermission('audit:read'), auditController.list);
auditRouter.get('/audit-log/:id', requirePermission('audit:read'), auditController.getOne);

module.exports = auditRouter;
