'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./feature-flags.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'feature-flags');

// M9-D870: registro de flags e configurações. As três rotas do livro exigem a permissão de gestão de flags e o módulo ligado para a empresa.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/feature-flags', permission: 'governance:flags:manage', handler: controller.list },
  { method: 'post', path: '/feature-flags', permission: 'governance:flags:manage', handler: controller.create },
  { method: 'patch', path: '/feature-flags', permission: 'governance:flags:manage', handler: controller.update },
]);

module.exports = router;
