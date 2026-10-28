'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const c = require('./knowledge.controller');

/** Base de conhecimento é da empresa toda, não de um agente: só a chave geral da NAY vale (não a lista `ai.agents.enabled`). */
const gate = aiGate({ agentParam: '__sem_agente__' });

/** Monta as rotas de conhecimento no router de /v1/ai (que já aplicou autenticação e tenant sob /ai). Tudo exige `ai:admin`. */
function registerKnowledgeRoutes(router) {
  const base = '/ai/knowledge';
  router.get(base, requirePermission('ai:admin'), gate, c.list);
  router.post(base, requirePermission('ai:admin'), gate, c.create);
  router.get(`${base}/:id`, requirePermission('ai:admin'), gate, c.getOne);
  router.patch(`${base}/:id`, requirePermission('ai:admin'), gate, c.update);
  router.post(`${base}/:id/homologate`, requirePermission('ai:admin'), gate, c.homologate);
  router.post(`${base}/:id/revoke`, requirePermission('ai:admin'), gate, c.revoke);
}

module.exports = { registerKnowledgeRoutes };
