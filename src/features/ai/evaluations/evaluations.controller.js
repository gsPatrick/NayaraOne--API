'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { safeLogger } = require('../audit');
const svc = new (require('./AiEvaluationService').AiEvaluationService)();

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });
const tx = (req, fn) => req.withTenantTransaction(fn);

/**
 * Depois da resposta, executa a avaliação enfileirada em transação própria (job assíncrono, sem bloquear o pedido). Se o
 * processo cair antes, o job de varredura (engines/jobs/aiEvaluationJob) pega a QUEUED que sobrou.
 */
function runLater(req, evaluationId) {
  setImmediate(() => {
    tx(req, (t) => svc.processQueued(ctxDe(req), t, { evaluationId }))
      .catch((err) => safeLogger.error({ err, evaluationId }, '[AiEvaluation] falha ao executar a avaliação enfileirada'));
  });
}

const run = catchAsync(async (req, res) => {
  const body = { ...(req.body || {}) };
  if (body.idempotencyKey === undefined && req.get('Idempotency-Key')) body.idempotencyKey = req.get('Idempotency-Key');
  const { evaluation, replayed } = await tx(req, (t) => svc.request(ctxDe(req), body, t));
  if (!replayed) runLater(req, evaluation.id);
  return success(res, { statusCode: 202, data: { evaluationRunId: evaluation.id, status: evaluation.status, replayed } });
});

const getOne = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => svc.get(ctxDe(req), req.params.id, t)) }));

const list = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => svc.list(ctxDe(req), req.query, t)) }));

const homologate = catchAsync(async (req, res) => {
  const { evaluation, replayed } = await tx(req, (t) => svc.homologate(ctxDe(req), req.params.id, req.body || {}, t));
  return success(res, { data: { ...evaluation, replayed } });
});

const feedback = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => svc.feedback(ctxDe(req), req.params.id, req.body, t));
  return success(res, { statusCode: data.replaced ? 200 : 201, data });
});

const listCandidates = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => svc.listCandidates(ctxDe(req), req.query, t)) }));

const decide = (name) => catchAsync(async (req, res) => {
  const { candidate, replayed } = await tx(req, (t) => svc[name](ctxDe(req), req.params.id, req.body || {}, t));
  return success(res, { data: { ...candidate, replayed } });
});

module.exports = { run, getOne, list, homologate, feedback, listCandidates, approveCandidate: decide('approveCandidate'), rejectCandidate: decide('rejectCandidate') };
