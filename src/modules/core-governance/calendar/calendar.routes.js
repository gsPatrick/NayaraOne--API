'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./calendar.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'calendar');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/calendar', permission: 'governance:calendar:read', handler: controller.getOverview },
]);

module.exports = router;
