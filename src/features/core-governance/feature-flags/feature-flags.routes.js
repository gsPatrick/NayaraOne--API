'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./feature-flags.controller');
const killSwitch = require('./kill-switch/killSwitch.routes');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'feature-flags');

// M9-D870: registro de flags e configurações. As três rotas do livro exigem a permissão de gestão de flags e o módulo ligado para a empresa.
const router = buildModuleRouter(MODULE, [
  // Rodada 8 (DI-M9R-24): a consulta tem esquema (kind como objeto ou fora da lista virava o nome da tabela no SQL).
  { method: 'get', path: '/feature-flags', permission: 'governance:flags:manage', after: [require('./flags.query.schema').validarListagemDeFlags], handler: controller.list },
  { method: 'post', path: '/feature-flags', permission: 'governance:flags:manage', handler: controller.create },
  // M9-D872: acionar e restaurar o kill switch (linha 14 da M9-D852) pelo próprio PATCH; a simulação do impacto é o POST /feature-flags/impact.
  { method: 'post', path: '/feature-flags/impact', permission: 'governance:flags:manage', after: killSwitch.impactMiddleware(), handler: killSwitch.impactFallback },
  { method: 'patch', path: '/feature-flags', permission: 'governance:flags:manage', after: killSwitch.patchGuards(), handler: controller.update },
]);

module.exports = router;
