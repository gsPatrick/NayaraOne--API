'use strict';

const catchAsync = require('../../../utils/catchAsync');
const AppError = require('../../../utils/AppError');
const { success } = require('../../../utils/httpResponse');
const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { anyOf } = require('../anyOf');
const { pageRecommendations, getRecommendation } = require('./recommendation.read');
const { readRecommendationParams } = require('./recommendation.params');

/** Recomendação é da empresa toda, não de um agente: só a chave geral da NAY vale. */
const gate = aiGate({ agentParam: '__sem_agente__' });

/** Tamanho padrão da página (livro: "paginação 20/100"; o máximo, 100, é o parâmetro ia.recomendacao.lista_max_itens). */
const DEFAULT_PAGE_SIZE = 20;
const REASON_MIN = 5;
const REASON_MAX = 500;

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });

const list = catchAsync(async (req, res) => {
  const q = req.query || {};
  const out = await req.withTenantTransaction((tx) => pageRecommendations(
    ctxDe(req), { status: q.status ? String(q.status).toUpperCase() : undefined, limit: q.limit, page: q.page, defaultLimit: DEFAULT_PAGE_SIZE }, tx
  ));
  return success(res, { data: out.items, pagination: { page: out.page, limit: out.limit, total: out.total } });
});

const getOne = catchAsync(async (req, res) => success(res, { data: await req.withTenantTransaction((tx) => getRecommendation(ctxDe(req), req.params.id, tx)) }));

/**
 * Motivo da rejeição: texto de 5 a 500 caracteres. Obrigatório enquanto `ia.recomendacao.motivo_rejeicao_obrigatorio` estiver ligado
 * (padrão); sem o motivo a resposta é 400 AI_REJECTION_REASON_REQUIRED. Roda antes do handler de decisão (M9-D019), que só recebe o
 * pedido já conferido; o handler aplica o resto da regra (aprovador, estado, replay).
 */
const checkRejectReason = catchAsync(async (req, res, next) => {
  const reason = req.body && req.body.reason;
  const given = typeof reason === 'string' && reason.trim().length > 0;
  const required = (await req.withTenantTransaction((tx) => readRecommendationParams(ctxDe(req), tx))).reasonRequired;
  const refuse = () => next(new AppError('Informe o motivo da rejeição.', 400, 'AI_REJECTION_REASON_REQUIRED', { min: REASON_MIN, max: REASON_MAX }));
  if (!given) return required ? refuse() : next();
  const size = reason.trim().length;
  return size < REASON_MIN || size > REASON_MAX ? refuse() : next();
});

/** GET /v1/ai/recommendations[/:id] e a conferência do motivo em POST .../reject (no router de /v1/ai, que já autentica e abre o tenant). */
function registerRecommendationRoutes(router) {
  router.get('/ai/recommendations', anyOf('ai:read', 'ai:audit'), gate, list);
  router.get('/ai/recommendations/:id', anyOf('ai:read', 'ai:audit'), gate, getOne);
  router.post('/ai/recommendations/:id/reject', requirePermission('ai:approve'), gate, checkRejectReason);
}

module.exports = { registerRecommendationRoutes, DEFAULT_PAGE_SIZE };
