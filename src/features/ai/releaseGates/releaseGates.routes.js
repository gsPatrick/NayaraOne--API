'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { PERMISSION } = require('./releaseGates.constants');
const c = require('./releaseGates.controller');

/**
 * GET/POST /v1/ai/release-gates (no router de /v1/ai, que já autentica e abre o tenant). Só ai:admin. Sem o portão da chave geral da NAY
 * (aiGate): as aprovações existem ANTES de a NAY ser ligada em produção.
 */
function registerReleaseGateRoutes(router) {
  router.get('/ai/release-gates', requirePermission(PERMISSION), c.list);
  router.post('/ai/release-gates', requirePermission(PERMISSION), c.create);
}

module.exports = { registerReleaseGateRoutes };
