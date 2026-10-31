'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./legalHold.controller');
const { MANAGE_PERMISSION, READ_PERMISSIONS, ACTION_RELEASE } = require('./legalHold.constants');
const { requireRecentMfa } = require('../../../middlewares/auth.middleware');
const { requireIdempotencyKey } = require('../dlp/idempotency.header');
const { confirmAction } = require('../../../shared/destructive-actions/guard');
const { impactHandler } = require('../../../shared/destructive-actions/impact.handler');

const DATA_QUALITY = GOVERNANCE_MODULES.find((item) => item.code === 'data-quality');
const MODULE = { ...DATA_QUALITY, prefix: '/legal-holds' }; // o liga/desliga do módulo Dados mestres vale também para a retenção legal

// Retenção legal (M9-D912): criar e liberar exigem governance:legal-hold:manage; a leitura aceita também a dos stewards (governance:data-quality:read). A liberação é a linha 11
// do inventário de ações destrutivas (M9-D852): nível 3, MFA, Idempotency-Key, código da retenção digitado, justificativa (o controlador a usa como motivo da liberação quando o corpo não traz `release_reason`; o corpo não é alterado, para a chave de idempotência continuar valendo) e impacto.
module.exports = buildModuleRouter(MODULE, [
  { method: 'post', path: '/legal-holds', permission: MANAGE_PERMISSION, handler: controller.create },
  { method: 'get', path: '/legal-holds', permission: READ_PERMISSIONS, handler: controller.list },
  { method: 'get', path: '/legal-holds/:id/impact', permission: MANAGE_PERMISSION, handler: impactHandler(ACTION_RELEASE) },
  { method: 'get', path: '/legal-holds/:id', permission: READ_PERMISSIONS, handler: controller.get },
  { method: 'post', path: '/legal-holds/:id/release', permission: MANAGE_PERMISSION, after: [requireIdempotencyKey, requireRecentMfa, confirmAction(ACTION_RELEASE)], handler: controller.release },
]);
