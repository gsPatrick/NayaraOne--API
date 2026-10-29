'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./data-quality.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'data-quality');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/data-quality', permission: 'governance:data-quality:read', handler: controller.getOverview },
  // M9-D804: donos (owner) e curadores (steward) por domínio de dados.
  { method: 'get', path: '/data-quality/domains', permission: 'governance:data-quality:read', handler: controller.listDomains },
  { method: 'put', path: '/data-quality/domains/:code/assignments', permission: 'governance:data-quality:manage', handler: controller.designate },
]);

module.exports = router;
