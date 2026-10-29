'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { anyOf } = require('../anyOf');
const { PERMISSIONS } = require('./budgets.constants');
const c = require('./budgets.controller');

/** Orçamento é da empresa toda, não de um agente: só a chave geral da NAY vale. Lê quem tem ai:audit ou ai:budget; edita só ai:budget. */
const gate = aiGate({ agentParam: '__sem_agente__' });

/** GET/POST /v1/ai/budgets e PUT /v1/ai/budgets/:id (no router de /v1/ai, que já autentica e abre o tenant). */
function registerBudgetRoutes(router) {
  const base = '/ai/budgets';
  router.get(base, anyOf(PERMISSIONS.read, PERMISSIONS.edit), gate, c.list);
  router.post(base, requirePermission(PERMISSIONS.edit), gate, c.create);
  router.put(`${base}/:id`, requirePermission(PERMISSIONS.edit), gate, c.update);
}

module.exports = { registerBudgetRoutes };
