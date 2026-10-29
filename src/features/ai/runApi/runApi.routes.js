'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { handleExecution } = require('./runApi.handler');

/** Execução de runs pela porta de entrada da NAY (M9-D030). A ordem em toda rota é a do livro: auth, tenant, permissão, aiGate. */
const gateGeral = aiGate({ agentParam: '__sem_agente__' });

function registerRunApiRoutes(router) {
  // POST /v1/ai/runs: o agente vem no corpo, então a chave por agente (`ai.agents.enabled`) é conferida pelo handler.
  router.post('/ai/runs', requirePermission('ai:use'), gateGeral, catchAsync((req, res) => handleExecution(req, res, { kind: 'RUN', body: req.body })));
  // POST /v1/ai/agents/:code/chat: o aiGate confere a chave do agente do caminho (409 AI_AGENT_DISABLED).
  router.post('/ai/agents/:code/chat', requirePermission('ai:use'), aiGate(), catchAsync((req, res) => handleExecution(req, res, { kind: 'CHAT', agentCode: req.params.code, body: req.body })));
}

module.exports = { registerRunApiRoutes };
