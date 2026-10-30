'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { isAiSettingKey } = require('../../features/ai/ai.settings');
const { requireTemplateManageToAddPublicFields } = require('../../features/marketing/content/publicFields.settings');
const { requireAutomationManageForCadence } = require('../../features/marketing/automations/cadence/cadence.guard');
const { requireAutomationManageForAutopublish } = require('../../features/marketing/content/autopublish.guard');
const { isSloSettingKey } = require('../../features/integrations/health/slo');
const settingsController = require('./settings.controller');

const settingsRouter = Router();

settingsRouter.use(authMiddleware, tenantMiddleware);

// Chaves da NAY (ia.*, ai.*) só mudam com ai:admin, além de settings:update (M9-D003).
const requireAiAdminForAiKeys = (req, res, next) => (isAiSettingKey(req.params.key) ? requirePermission('ai:admin')(req, res, next) : next());

// Metas de SLO das integrações (integration.slo.*) só mudam com integration:manage, além de settings:update (M9-D225).
const requireIntegrationManageForSlo = (req, res, next) => (isSloSettingKey(req.params.key) ? requirePermission('integration:manage')(req, res, next) : next());

settingsRouter.get('/settings', requirePermission('settings:read'), settingsController.listSettings);
settingsRouter.get('/settings/integrations/status', requirePermission('settings:read'), settingsController.getIntegrationsStatus);
settingsRouter.get('/settings/:key', requirePermission('settings:read'), settingsController.getSetting);
settingsRouter.put('/settings/:key', requirePermission('settings:update'), requireAiAdminForAiKeys, requireIntegrationManageForSlo, requireTemplateManageToAddPublicFields, requireAutomationManageForCadence, requireAutomationManageForAutopublish, settingsController.upsertSetting);

module.exports = settingsRouter;
