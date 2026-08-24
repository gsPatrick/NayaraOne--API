'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const radarController = require('./radar.controller');

const radarRouter = Router();

radarRouter.use(authMiddleware, tenantMiddleware);

radarRouter.post('/radar', requirePermission('radar:create'), radarController.create);
radarRouter.get('/radar', requirePermission('radar:read'), radarController.list);
radarRouter.get('/radar/:id', requirePermission('radar:read'), radarController.getOne);
radarRouter.patch('/radar/:id', requirePermission('radar:update'), radarController.update);
radarRouter.delete('/radar/:id', requirePermission('radar:delete'), radarController.remove);
radarRouter.get('/radar/:id/matches', requirePermission('radar:read'), radarController.matches);

module.exports = radarRouter;
