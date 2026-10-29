'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const c = require('./evaluations.controller');

/** A avaliação é da empresa toda, não de um agente: só a chave geral da NAY vale. */
const gate = aiGate({ agentParam: '__sem_agente__' });

/** Rotas de avaliação e feedback (M9-D031/D032), montadas no router de /v1/ai (auth e tenant já aplicados sob /ai). */
function registerEvaluationRoutes(router) {
  router.post('/ai/evaluations/run', requirePermission('ai:evaluate'), gate, c.run);
  router.get('/ai/evaluations', requirePermission('ai:evaluate'), gate, c.list);
  router.get('/ai/evaluations/:id', requirePermission('ai:evaluate'), gate, c.getOne);
  router.post('/ai/evaluations/:id/homologate', requirePermission('ai:evaluate'), gate, c.homologate);
  router.post('/ai/runs/:id/feedback', requirePermission('ai:use'), gate, c.feedback);
  router.get('/ai/golden-candidates', requirePermission('ai:evaluate'), gate, c.listCandidates);
  router.post('/ai/golden-candidates/:id/approve', requirePermission('ai:evaluate'), gate, c.approveCandidate);
  router.post('/ai/golden-candidates/:id/reject', requirePermission('ai:evaluate'), gate, c.rejectCandidate);
}

module.exports = { registerEvaluationRoutes };
