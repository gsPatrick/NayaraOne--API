'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./data-quality.controller');
const mergeController = require('./merge.controller');
const bulkController = require('./bulk.controller');
const { auditDeniedBulk, requireIdempotencyKey } = require('./bulk.guard');
const { requireRecentMfa } = require('../../../middlewares/auth.middleware');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'data-quality');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/data-quality', permission: 'governance:data-quality:read', handler: controller.getOverview },
  // M9-D804: donos (owner) e curadores (steward) por domínio de dados.
  { method: 'get', path: '/data-quality/domains', permission: 'governance:data-quality:read', handler: controller.listDomains },
  { method: 'put', path: '/data-quality/domains/:code/assignments', permission: 'governance:data-quality:manage', handler: controller.designate },
  // M9-D805: filas de merge e review de Person, Property e Supplier.
  { method: 'get', path: '/data-quality/queue', permission: 'governance:data-quality:read', handler: mergeController.listQueue },
  { method: 'get', path: '/data-quality/queue/:id/impact', permission: 'governance:data-quality:read', handler: mergeController.impact },
  { method: 'post', path: '/data-quality/queue/:id/decision', permission: 'governance:data-quality:manage', handler: mergeController.decide },
  // M9-D808: alteração em massa de dados mestres (permissão própria, tentativa negada auditada, Idempotency-Key exigida e MFA recente; linha 9 da M9-D852).
  { method: 'post', path: '/data-quality/bulk-changes/impact', permission: 'governance:data-quality:bulk', before: [auditDeniedBulk], handler: bulkController.impact },
  { method: 'post', path: '/data-quality/bulk-changes', permission: 'governance:data-quality:bulk', before: [auditDeniedBulk], after: [requireIdempotencyKey, requireRecentMfa], handler: bulkController.create },
  { method: 'get', path: '/data-quality/bulk-changes', permission: 'governance:data-quality:bulk', handler: bulkController.list },
  { method: 'get', path: '/data-quality/bulk-changes/:id', permission: 'governance:data-quality:bulk', handler: bulkController.getOne },
]);

module.exports = router;
