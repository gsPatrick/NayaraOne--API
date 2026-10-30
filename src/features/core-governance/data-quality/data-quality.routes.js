'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./data-quality.controller');
const mergeController = require('./merge.controller');
const bulkController = require('./bulk.controller');
const { auditDeniedBulk, requireIdempotencyKey } = require('./bulk.guard');
const { requireRecentMfa } = require('../../../middlewares/auth.middleware');
const { confirmAction } = require('../../../shared/destructive-actions/guard');
const { impactHandler } = require('../../../shared/destructive-actions/impact.handler'); // M9-D852: corpo único de impacto, com impactToken

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'data-quality');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/data-quality', permission: 'governance:data-quality:read', handler: controller.getOverview },
  // M9-D804: donos (owner) e curadores (steward) por domínio de dados.
  { method: 'get', path: '/data-quality/domains', permission: 'governance:data-quality:read', handler: controller.listDomains },
  { method: 'put', path: '/data-quality/domains/:code/assignments', permission: 'governance:data-quality:manage', handler: controller.designate },
  // M9-D805: filas de merge e review de Person, Property e Supplier.
  { method: 'get', path: '/data-quality/queue', permission: 'governance:data-quality:read', handler: mergeController.listQueue },
  { method: 'get', path: '/data-quality/queue/:id/impact', permission: 'governance:data-quality:read', handler: impactHandler('data_quality.merge') },
  { method: 'post', path: '/data-quality/queue/:id/decision', permission: 'governance:data-quality:manage', after: [confirmAction('data_quality.merge', { mfa: true })], handler: mergeController.decide },
  // M9-D808: alteração em massa de dados mestres (permissão própria, tentativa negada auditada, Idempotency-Key exigida e MFA recente; linha 9 da M9-D852).
  { method: 'post', path: '/data-quality/bulk-changes/impact', permission: 'governance:data-quality:bulk', before: [auditDeniedBulk], handler: impactHandler('data_quality.bulk', { resourceId: () => null }) },
  { method: 'post', path: '/data-quality/bulk-changes', permission: 'governance:data-quality:bulk', before: [auditDeniedBulk], after: [requireIdempotencyKey, requireRecentMfa, confirmAction('data_quality.bulk', { resourceId: () => null, reasonField: 'reason' })], handler: bulkController.create },
  { method: 'get', path: '/data-quality/bulk-changes', permission: 'governance:data-quality:bulk', handler: bulkController.list },
  { method: 'get', path: '/data-quality/bulk-changes/:id', permission: 'governance:data-quality:bulk', handler: bulkController.getOne },
]);

module.exports = router;
