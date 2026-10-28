'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./bcp.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'bcp');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/bcp', permission: 'governance:bcp:record', handler: controller.getOverview },
]);

module.exports = router;
