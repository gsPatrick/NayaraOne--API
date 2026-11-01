'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { isAiSettingKey } = require('../../features/ai/ai.settings');
const { requireTemplateManageToAddPublicFields } = require('../../features/marketing/content/publicFields.settings');
const { requireAutomationManageForCadence } = require('../../features/marketing/automations/cadence/cadence.guard');
const { requireAutomationManageForAutopublish } = require('../../features/marketing/content/autopublish.guard');
const { isSloSettingKey } = require('../../features/integrations/health/slo');
const { securityPermissionOf } = require('./settingSecurity');
const { restrictedPermissionOf } = require('./settingRestricted');
const { auditDeniedSettingWrite } = require('./settingDenied');
const { isMigrationGateKey, MIGRATION_ADMIN_PERMISSION } = require('../../features/migration-v2/migration.gateKeys');
const { isPlatformOnly, PLATFORM_PERMISSION } = require('./settingPlatform');
const settingsService = require('./settings.service');
const settingsController = require('./settings.controller');

const settingsRouter = Router();

settingsRouter.use(authMiddleware, tenantMiddleware);

// Chaves da NAY (ia.*, ai.*) só mudam com ai:admin, além de settings:update (M9-D003).
const requireAiAdminForAiKeys = (req, res, next) => (isAiSettingKey(req.params.key) ? requirePermission('ai:admin')(req, res, next) : next());

// Metas de SLO das integrações (integration.slo.*) só mudam com integration:manage, além de settings:update (M9-D225).
const requireIntegrationManageForSlo = (req, res, next) => (isSloSettingKey(req.params.key) ? requirePermission('integration:manage')(req, res, next) : next());

// Parâmetros do portão do corte (validade, volume e commit do relatório DRY3, comparação paralela e etapas do canary) só mudam com governance:migration:admin, além de settings:update (M9-D908 R3-L3).
const requireMigrationAdminForGateKeys = (req, res, next) => (isMigrationGateKey(req.params.key) ? requirePermission(MIGRATION_ADMIN_PERMISSION)(req, res, next) : next());

// Chaves `platformOnly` do dicionário (destino de saída, hosts de fornecedor, política de egress) só mudam com integration:platform, nunca com o ADMIN da empresa (M9-D245 N1).
// A mesma regra vale na camada de escrita (upsertSetting), que cobre os caminhos sem esta rota (M9-D870 R3-M1).
const requirePlatformForPlatformKeys = (req, res, next) => (isPlatformOnly(settingsService.SETTINGS_SCHEMA[req.params.key]) ? requirePermission(PLATFORM_PERMISSION)(req, res, next) : next());

// Chaves de segurança da governança (DLP, limite de requisições, confirmação, flags) exigem a permissão do dono da regra além de settings:update (M9-D870 R4-L1).
const requireSecurityOwner = (req, res, next) => { const permission = securityPermissionOf(req.params.key); return permission ? requirePermission(permission)(req, res, next) : next(); };

settingsRouter.get('/settings', requirePermission('settings:read'), settingsController.listSettings);
settingsRouter.get('/settings/integrations/status', requirePermission('settings:read'), settingsController.getIntegrationsStatus);
settingsRouter.get('/settings/:key', requirePermission('settings:read'), settingsController.getSetting);
settingsRouter.put('/settings/:key', requirePermission('settings:update'), requireAiAdminForAiKeys, requireIntegrationManageForSlo, requireMigrationAdminForGateKeys, requireSecurityOwner, requirePlatformForPlatformKeys, requireTemplateManageToAddPublicFields, requireAutomationManageForCadence, requireAutomationManageForAutopublish, settingsController.upsertSetting);

// Tentativa negada de gravar chave protegida (permissão própria, plataforma ou dono): audita em audit.audit_log (M9-D870 R4-L3) e deixa a resposta 403 como está.
settingsRouter.use(async (err, req, res, next) => {
  const key = req.method === 'PUT' ? /^\/settings\/([^/]+)$/.exec(req.path) : null;
  const name = key && decodeURIComponent(key[1]);
  if (name && (restrictedPermissionOf(name) || isPlatformOnly(settingsService.SETTINGS_SCHEMA[name]))) await auditDeniedSettingWrite(req, { key: name, via: 'PUT /settings', err });
  return next(err);
});

module.exports = settingsRouter;
