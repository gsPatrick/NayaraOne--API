'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { anyOf } = require('../anyOf');
const { staleError } = require('../recommendations');
const AE = require('./approval.errors');
const service = require('./ApprovalService');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });
const gate = aiGate({ agentParam: '__sem_agente__' });

const view = (out) => ({ recommendation: out.recommendation, replayed: out.replayed === true, outcome: out.outcome || null, outcomeDetail: out.outcomeDetail || null });

/** O STALE é gravado e confirmado primeiro; só depois a rota responde 409 (se lançasse dentro da transação, ela desfaria o STALE). */
const accept = catchAsync(async (req, res) => {
  const out = await req.withTenantTransaction((tx) => service.approveRecommendation(ctxDe(req), req.params.id, req.body, tx));
  if (out.stale) throw (out.integrity ? AE.integrity() : staleError());
  return success(res, { data: view(out) });
});

const reject = catchAsync(async (req, res) => {
  const out = await req.withTenantTransaction((tx) => service.rejectRecommendation(ctxDe(req), req.params.id, req.body, tx));
  return success(res, { data: view(out) });
});

/** POST /v1/ai/recommendations/:id/accept|reject (no router de /v1/ai, que já autentica e abre o tenant). Reject exige `ai:approve`; accept, `ai:approve` ou (informativa dirigida à pessoa) `ai:read`. */
function registerApprovalRoutes(router) {
  // A recomendação informativa (sem ação) é aceita pelo destinatário com ai:read (M9-D007/D031); a de ação proposta exige ai:approve (o serviço confere por recomendação).
  router.post('/ai/recommendations/:id/accept', anyOf('ai:approve', 'ai:read'), gate, accept);
  router.post('/ai/recommendations/:id/reject', requirePermission('ai:approve'), gate, reject);
}

module.exports = { registerApprovalRoutes };
