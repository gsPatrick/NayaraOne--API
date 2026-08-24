'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const unitsController = require('./units.controller');

const unitsRouter = Router();

unitsRouter.use(authMiddleware, tenantMiddleware);

unitsRouter.post('/units', requirePermission('units:create'), unitsController.create);
unitsRouter.get('/units', requirePermission('units:read'), unitsController.list);
unitsRouter.get('/units/:id', requirePermission('units:read'), unitsController.getOne);
unitsRouter.patch('/units/:id', requirePermission('units:update'), unitsController.update);
unitsRouter.delete('/units/:id', requirePermission('units:delete'), unitsController.remove);

module.exports = unitsRouter;
