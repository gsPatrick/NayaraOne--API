'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const membershipsController = require('./memberships.controller');

const membershipsRouter = Router();

membershipsRouter.use(authMiddleware, tenantMiddleware);

// Conceder/revogar vínculo (papel) de um usuário é ação HIGH (Caderno §3.3) — exige MFA recente.
membershipsRouter.post('/memberships', requirePermission('memberships:create'), requireRecentMfa, membershipsController.create);
membershipsRouter.get('/memberships', requirePermission('memberships:read'), membershipsController.list);
membershipsRouter.delete('/memberships/:id', requirePermission('memberships:delete'), requireRecentMfa, membershipsController.revoke);
membershipsRouter.get(
  '/memberships/:userId/effective-permissions',
  requirePermission('memberships:read'),
  membershipsController.effectivePermissions
);

module.exports = membershipsRouter;
