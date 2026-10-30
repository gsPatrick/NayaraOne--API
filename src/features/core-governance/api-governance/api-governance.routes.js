'use strict';

const { Router } = require('express');
const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./api-governance.controller');
const externalRouter = require('./clients/external.routes');
const { requireRecentMfa } = require('../../../middlewares/auth.middleware');
const { confirmAction } = require('../../../shared/destructive-actions/guard'); // M9-D852 linha 13: nível 3 com MFA recente

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'api-governance');

// Consumidores e deprecações (M9-D841): leitura com governance:api:read, escrita com governance:api:manage.
const moduleRouter = buildModuleRouter(MODULE, [
  { method: 'get', path: '/api-governance/consumers', permission: 'governance:api:read', handler: controller.listConsumers },
  { method: 'get', path: '/api-governance/deprecations', permission: 'governance:api:read', handler: controller.listDeprecations },
  { method: 'post', path: '/api-governance/deprecations', permission: 'governance:api:manage', handler: controller.createDeprecation },
  { method: 'post', path: '/api-governance/deprecations/:id/cancel', permission: 'governance:api:manage', handler: controller.cancelDeprecation },
  // Credenciais da API externa (M9-D844): criar e revogar exigem governance:api:manage; o segredo aparece só na criação.
  { method: 'get', path: '/api-governance/clients', permission: 'governance:api:read', handler: controller.listClients },
  { method: 'post', path: '/api-governance/clients', permission: 'governance:api:manage', after: [requireRecentMfa, confirmAction('api_client.create', { resourceId: () => null })], handler: controller.createClient },
  { method: 'post', path: '/api-governance/clients/:id/revoke', permission: 'governance:api:manage', after: [requireRecentMfa, confirmAction('api_client.revoke')], handler: controller.revokeClient },
]);

// API externa (M9-D844): /api-external/* tem autenticação própria (token de cliente) e não passa pelo login de usuário.
const router = Router();
router.use(externalRouter);
router.use(moduleRouter);

module.exports = router;
