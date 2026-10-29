'use strict';

const router = require('./ai.routes');
const { aiGate, isAiEnabled, isAgentEnabled } = require('./aiGate.middleware');
const { AI_PERMISSIONS, AI_PERMISSION_CODES } = require('./ai.permissions');
const { AiOrchestrator } = require('./orchestrator');
const { ToolRegistry } = require('./tools');
const { RetrievalService } = require('./retrieval');
const { MemoryService } = require('./memory');
const { ModelRouter } = require('./providers');
const { AiEvaluationService } = require('./evaluations');
const regression = require('./regression');
const nayAtendimento = require('./agents/nay_atendimento');

/**
 * src/features/ai — a NAY do Marco 9 (Caderno, Guia do Marcelo §2): providers, agents, tools, retrieval, memory, evaluations,
 * budgets, orchestrator e readmodels. Rotas em /v1/ai/*; chave geral `ia.habilitada` e chave por agente `ai.agents.enabled`.
 */
module.exports = {
  router,
  aiGate,
  isAiEnabled,
  isAgentEnabled,
  AI_PERMISSIONS,
  AI_PERMISSION_CODES,
  AiOrchestrator,
  ToolRegistry,
  RetrievalService,
  MemoryService,
  ModelRouter,
  AiEvaluationService,
  regression,
  nayAtendimento,
};
