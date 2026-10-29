'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./api-governance.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'api-governance');

// Consumidores e deprecações (M9-D841): leitura com governance:api:read, escrita com governance:api:manage.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/api-governance/consumers', permission: 'governance:api:read', handler: controller.listConsumers },
  { method: 'get', path: '/api-governance/deprecations', permission: 'governance:api:read', handler: controller.listDeprecations },
  { method: 'post', path: '/api-governance/deprecations', permission: 'governance:api:manage', handler: controller.createDeprecation },
  { method: 'post', path: '/api-governance/deprecations/:id/cancel', permission: 'governance:api:manage', handler: controller.cancelDeprecation },
]);

module.exports = router;
