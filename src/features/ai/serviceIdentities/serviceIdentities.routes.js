'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const c = require('./serviceIdentities.controller');

/** Identidade de serviço é da empresa toda, não de um agente: só a chave geral da NAY vale. Tudo exige `ai:admin`. */
const gate = aiGate({ agentParam: '__sem_agente__' });

/** GET/POST /v1/ai/service-identities e PATCH /v1/ai/service-identities/:id (no router de /v1/ai, que já autentica e abre o tenant). */
function registerServiceIdentityRoutes(router) {
  const base = '/ai/service-identities';
  router.get(base, requirePermission('ai:admin'), gate, c.list);
  router.post(base, requirePermission('ai:admin'), gate, c.create);
  router.patch(`${base}/:id`, requirePermission('ai:admin'), gate, c.update);
}

module.exports = { registerServiceIdentityRoutes };
