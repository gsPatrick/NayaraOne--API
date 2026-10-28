'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./lineage.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'lineage');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/lineage', permission: 'governance:lineage:manage', handler: controller.getOverview },
]);

module.exports = router;
