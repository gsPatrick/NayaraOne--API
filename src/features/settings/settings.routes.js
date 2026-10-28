'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { isAiSettingKey } = require('../../modules/ai/ai.settings');
const { requireTemplateManageToAddPublicFields } = require('../../modules/marketing/content/publicFields.settings');
const { requireAutomationManageForCadence } = require('../../modules/marketing/automations/cadence/cadence.guard');
const settingsController = require('./settings.controller');

const settingsRouter = Router();

settingsRouter.use(authMiddleware, tenantMiddleware);

// Chaves da NAY (ia.*, ai.*) só mudam com ai:admin, além de settings:update (M9-D003).
const requireAiAdminForAiKeys = (req, res, next) => (isAiSettingKey(req.params.key) ? requirePermission('ai:admin')(req, res, next) : next());

settingsRouter.get('/settings', requirePermission('settings:read'), settingsController.listSettings);
settingsRouter.get('/settings/integrations/status', requirePermission('settings:read'), settingsController.getIntegrationsStatus);
settingsRouter.get('/settings/:key', requirePermission('settings:read'), settingsController.getSetting);
settingsRouter.put('/settings/:key', requirePermission('settings:update'), requireAiAdminForAiKeys, requireTemplateManageToAddPublicFields, requireAutomationManageForCadence, settingsController.upsertSetting);

module.exports = settingsRouter;
