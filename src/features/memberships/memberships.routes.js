'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const membershipsController = require('./memberships.controller');

const membershipsRouter = Router();

membershipsRouter.use(authMiddleware, tenantMiddleware);

membershipsRouter.post('/memberships', requirePermission('memberships:create'), membershipsController.create);
membershipsRouter.get('/memberships', requirePermission('memberships:read'), membershipsController.list);
membershipsRouter.delete('/memberships/:id', requirePermission('memberships:delete'), membershipsController.revoke);
membershipsRouter.get(
  '/memberships/:userId/effective-permissions',
  requirePermission('memberships:read'),
  membershipsController.effectivePermissions
);

module.exports = membershipsRouter;
