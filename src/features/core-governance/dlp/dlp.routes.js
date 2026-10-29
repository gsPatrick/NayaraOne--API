'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const { EXPORT_PERMISSION, ADMIN_PERMISSION } = require('./dlp.constants');
const controller = require('./dlp.controller');
const policyController = require('./policy.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'dlp');

// GET /dlp: esqueleto do alicerce (M9-D800). /dlp/policies: a política por classe e ação (M9-D820): leitura com `dlp:export` ou `dlp:admin`, escrita só com `dlp:admin`.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/dlp', permission: ADMIN_PERMISSION, handler: controller.getOverview },
  { method: 'get', path: '/dlp/policies', permission: [EXPORT_PERMISSION, ADMIN_PERMISSION], handler: policyController.listPolicies },
  { method: 'put', path: '/dlp/policies/:classification/:action', permission: ADMIN_PERMISSION, handler: policyController.putPolicy },
]);

module.exports = router;
