'use strict';

const { buildModuleRouter } = require('../../governance.module');
const { GOVERNANCE_MODULES } = require('../../governance.settings');
const { EXPORT_PERMISSION, ADMIN_PERMISSION } = require('../dlp.constants');
const { requireIdempotencyKey } = require('../idempotency.header');
const controller = require('./export.controller');

const DLP = GOVERNANCE_MODULES.find((item) => item.code === 'dlp');
const MODULE = { ...DLP, prefix: '/exports' };

// POST /exports pede `governance:dlp:export` (mais a permissão do módulo de origem, aplicada pelo guard); ler o estado e baixar: o pedido é de quem pediu ou de `governance:dlp:admin`.
module.exports = buildModuleRouter(MODULE, [
  { method: 'post', path: '/exports', permission: EXPORT_PERMISSION, after: [requireIdempotencyKey], handler: controller.postExport },
  { method: 'get', path: '/exports/catalog', permission: [EXPORT_PERMISSION, ADMIN_PERMISSION], handler: controller.getCatalog },
  { method: 'get', path: '/exports/:id', permission: [EXPORT_PERMISSION, ADMIN_PERMISSION], handler: controller.getOne },
  { method: 'get', path: '/exports/:id/download', permission: [EXPORT_PERMISSION, ADMIN_PERMISSION], handler: controller.download },
]);
