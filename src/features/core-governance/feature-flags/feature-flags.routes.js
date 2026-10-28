'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./feature-flags.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'feature-flags');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/feature-flags', permission: 'governance:flags:manage', handler: controller.getOverview },
]);

module.exports = router;
