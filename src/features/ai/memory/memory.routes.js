'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { anyOf } = require('../anyOf');
const c = require('./memory.controller');

/** Memória é da empresa toda, não de um agente: só a chave geral da NAY vale. */
const gate = aiGate({ agentParam: '__sem_agente__' });
const readers = anyOf('ai:use', 'ai:audit', 'ai:admin');
const writers = anyOf('ai:use', 'ai:admin');

/**
 * Rotas da memória, no router de /v1/ai (que já aplicou autenticação e tenant). A regra fina de quem grava cada tipo e de quem
 * enxerga cada escopo é do serviço; aqui só a permissão de entrada. DELETE existe só para responder 409 (memória não se apaga).
 */
function registerMemoryRoutes(router) {
  const base = '/ai/memories';
  router.get(base, readers, gate, require('./memory.query.schema').validarListagemDeMemorias, c.list);
  router.post(base, writers, gate, c.create);
  router.get(`${base}/:id`, readers, gate, c.getOne);
  router.post(`${base}/:id/invalidate`, writers, gate, c.invalidate);
  router.post(`${base}/:id/correct`, writers, gate, c.correct);
  router.delete(`${base}/:id`, requirePermission('ai:use'), gate, c.remove);
}

module.exports = { registerMemoryRoutes };
