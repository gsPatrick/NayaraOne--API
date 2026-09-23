'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const settingsController = require('./settings.controller');

const settingsRouter = Router();

settingsRouter.use(authMiddleware, tenantMiddleware);

settingsRouter.get('/settings', requirePermission('settings:read'), settingsController.listSettings);
settingsRouter.get('/settings/integrations/status', requirePermission('settings:read'), settingsController.getIntegrationsStatus);
settingsRouter.get('/settings/:key', requirePermission('settings:read'), settingsController.getSetting);
settingsRouter.put('/settings/:key', requirePermission('settings:update'), settingsController.upsertSetting);

module.exports = settingsRouter;
