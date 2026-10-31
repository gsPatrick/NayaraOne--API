'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const { EXPORT_PERMISSION, ADMIN_PERMISSION } = require('./dlp.constants');
const controller = require('./dlp.controller');
const policyController = require('./policy.controller');
const { SHARE_ROUTES } = require('./share/share.routes');
const anomalyController = require('./anomaly.controller');
const copyController = require('./copy.controller');
const printController = require('./print/print.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'dlp');

// GET /dlp: esqueleto do alicerce (M9-D800). /dlp/policies: a política por classe e ação (M9-D820): leitura com `dlp:export` ou `dlp:admin`, escrita só com `dlp:admin`.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/dlp', permission: ADMIN_PERMISSION, handler: controller.getOverview },
  { method: 'get', path: '/dlp/policies', permission: [EXPORT_PERMISSION, ADMIN_PERMISSION], handler: policyController.listPolicies },
  { method: 'put', path: '/dlp/policies/:classification/:action', permission: ADMIN_PERMISSION, handler: policyController.putPolicy },
  // Anomalia de acesso em massa (M9-D824): lista para a revisão e decisão humana com motivo (CONFIRMED ou FALSE_POSITIVE).
  { method: 'get', path: '/dlp/anomalies', permission: ADMIN_PERMISSION, handler: anomalyController.list },
  { method: 'post', path: '/dlp/anomalies/:id/review', permission: ADMIN_PERMISSION, handler: anomalyController.reviewOne },
  // Registro de cópia vinda da tela (M9-D825 §3.2b): exige apenas login, porque registra a ação do próprio usuário; o servidor reavalia a política.
  { method: 'post', path: '/dlp/copy-events', permission: null, handler: copyController.createCopyEvent },
  // Impressão (M9-D920 §3.1): o pedido passa pelo guard antes da visão de impressão (login; o guard confere a permissão do módulo de origem) e o PDF sai por endereço assinado de uso único.
  { method: 'post', path: '/dlp/print-events', permission: null, handler: printController.postPrintEvent },
  { method: 'get', path: '/dlp/print-events/:id/pdf', permission: null, handler: printController.getPrintPdf },
  ...SHARE_ROUTES,
]);

module.exports = router;
