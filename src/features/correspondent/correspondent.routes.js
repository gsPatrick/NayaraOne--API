'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const casesController = require('./cases/financingCases.controller');

const correspondentRouter = Router();
correspondentRouter.use(authMiddleware, tenantMiddleware);

correspondentRouter.post('/financing-cases', requirePermission('correspondent:create'), casesController.createFinancingCase);
correspondentRouter.get('/financing-cases', requirePermission('correspondent:read'), casesController.listFinancingCases);
correspondentRouter.get('/financing-cases/:id', requirePermission('correspondent:read'), casesController.getFinancingCase);

module.exports = correspondentRouter;
