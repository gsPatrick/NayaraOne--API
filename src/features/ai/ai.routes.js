'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { getSetting } = require('../../features/settings/settings.service');
const { aiGate } = require('./aiGate.middleware');
const { aiNotAvailable } = require('./ai.errors');
const { registerAgentRoutes } = require('./agents/agents.routes');
const { registerRunRoutes } = require('./orchestrator/runs/runs.routes');
const { registerKnowledgeRoutes } = require('./knowledge/knowledge.routes');
const { registerToolRoutes } = require('./tools/tools.routes');
const { registerServiceIdentityRoutes } = require('./serviceIdentities/serviceIdentities.routes');
const { registerEvaluationRoutes } = require('./evaluations/evaluations.routes');
const { registerRecommendationRoutes } = require('./recommendations/recommendations.routes');
const { registerApprovalRoutes } = require('./approval/approval.routes');
const { registerBudgetRoutes } = require('./budgets/budgets.routes');
const { registerMemoryRoutes } = require('./memory/memory.routes');
const { registerIngestionRoutes } = require('./retrieval/ingestion.routes');
const { AI_AGENTS_ENABLED_KEY, AI_SETTING_DEFAULTS, parseAgentList } = require('./ai.settings');

/**
 * Rotas da NAY, montadas em /v1/ai/*. Ordem em toda rota: authMiddleware -> tenantMiddleware -> requirePermission -> aiGate -> handler.
 * Auth e tenant valem só sob /ai (nunca router.use sem caminho, que interceptaria o resto de /v1).
 * O conteúdo de runs e chat é de M9-D004 em diante: até lá os handlers respondem 501 AI_NOT_AVAILABLE (depois do gate).
 */
const router = Router();
router.use('/ai', authMiddleware, tenantMiddleware);

router.get('/ai/status', requirePermission('ai:read'), aiGate(), catchAsync(async (req, res) => {
  const raw = await req.withTenantTransaction((transaction) => getSetting(
    AI_AGENTS_ENABLED_KEY, { groupId: req.auth.groupId, companyId: req.auth.companyId }, transaction, AI_SETTING_DEFAULTS[AI_AGENTS_ENABLED_KEY]
  ));
  const list = parseAgentList(raw);
  return success(res, { data: { habilitada: true, agentes: list.all ? '*' : [...list.codes] } });
}));

// Versões de agentes (M9-D004): GET /ai/agents e /ai/agents/:code/versions/*.
registerAgentRoutes(router);
// Leitura de um run com as fontes (M9-D005): GET /ai/runs/:id. Declarada antes do stub POST /ai/runs (métodos diferentes).
registerRunRoutes(router);
// Conhecimento homologado e versionado (M9-D008): /ai/knowledge.
registerKnowledgeRoutes(router);
// Catálogo das tools registradas no servidor (M9-D016): GET /ai/tools.
registerToolRoutes(router);
// Identidades de serviço da NAY, só leitura (M9-D017): /ai/service-identities.
registerServiceIdentityRoutes(router);
// Avaliações, homologação humana, feedback e fila de candidatos ao golden dataset (M9-D031/D032).
registerEvaluationRoutes(router);
// Lista e leitura das recomendações e conferência do motivo da rejeição (M9-D031). Antes da decisão (D019), que recebe o pedido já conferido.
registerRecommendationRoutes(router);
// Decisão humana das propostas da NAY (M9-D019): POST /ai/recommendations/:id/accept|reject.
registerApprovalRoutes(router);
// Orçamento de uso da NAY (M9-D014): GET/POST /ai/budgets e PUT /ai/budgets/:id.
registerBudgetRoutes(router);
// Memória empresarial estruturada (M9-D009): /ai/memories, invalidate e correct.
registerMemoryRoutes(router);
// Ingestão segura de arquivos, URLs e conhecimento no índice do RAG (M9-D022): POST/GET /ai/ingestions e PUT /ai/files/:fileId/classification.
registerIngestionRoutes(router);

router.post('/ai/runs', requirePermission('ai:use'), aiGate(), (req, res, next) => next(aiNotAvailable('runs')));
router.post('/ai/agents/:code/chat', requirePermission('ai:use'), aiGate(), (req, res, next) => next(aiNotAvailable('chat')));

module.exports = router;
