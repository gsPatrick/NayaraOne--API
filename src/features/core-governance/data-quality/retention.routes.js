'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./retention.controller');
const { PERMISSION, READ_PERMISSIONS } = require('./retention.constants');
const { requireIdempotencyKey } = require('../dlp/idempotency.header');
const { requireRecentMfa } = require('../../../middlewares/auth.middleware');
const { confirmAction } = require('../../../shared/destructive-actions/guard');
const { impactHandler } = require('../../../shared/destructive-actions/impact.handler');

const DATA_QUALITY = GOVERNANCE_MODULES.find((item) => item.code === 'data-quality');
const MODULE = { ...DATA_QUALITY, prefix: '/retention' }; // o liga/desliga do módulo Dados mestres vale também para a retenção

// Retenção (M9-D911): políticas, simulação e aplicação. O apply é a linha 10 do inventário de ações destrutivas (M9-D852): nível 3, MFA, Idempotency-Key, código da rodada e impacto.
module.exports = buildModuleRouter(MODULE, [
  { method: 'get', path: '/retention/policies', permission: READ_PERMISSIONS, handler: controller.listPolicies },
  { method: 'put', path: '/retention/policies', permission: PERMISSION, handler: controller.putPolicy },
  { method: 'post', path: '/retention/dry-run', permission: PERMISSION, handler: controller.dryRun },
  { method: 'get', path: '/retention/runs', permission: READ_PERMISSIONS, handler: controller.listRuns },
  { method: 'get', path: '/retention/runs/:id', permission: READ_PERMISSIONS, handler: controller.getRun },
  { method: 'get', path: '/retention/runs/:id/impact', permission: PERMISSION, handler: impactHandler('retention.apply') },
  { method: 'post', path: '/retention/runs/:id/apply', permission: PERMISSION, after: [requireIdempotencyKey, requireRecentMfa, confirmAction('retention.apply')], handler: controller.apply },
]);
