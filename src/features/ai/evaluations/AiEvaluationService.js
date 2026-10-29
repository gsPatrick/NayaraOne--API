'use strict';

const { requestEvaluation } = require('./evaluations.request');
const { getEvaluation, listEvaluations } = require('./evaluations.read');
const { homologateEvaluation } = require('./evaluations.homologate');
const { processQueued } = require('./evaluationRunner');
const { recordFeedback } = require('./feedback/feedback.service');
const { listCandidates, decideCandidate } = require('./feedback/goldenCandidates.service');

/**
 * AiEvaluationService — avaliações e homologação de versões da NAY (M9-D032). Fachada fina: cada responsabilidade vive no
 * próprio arquivo. A avaliação automática só diz "elegível" (PASSED); quem homologa é uma pessoa (AI-015) e quem ativa é outra
 * decisão (ai:admin, agents/agentLifecycle). O feedback humano só alimenta a avaliação.
 */
class AiEvaluationService {
  constructor() {
    this.nome = 'AiEvaluationService';
  }

  request(ctx, body, transaction) { return requestEvaluation(ctx, body, transaction); }

  get(ctx, id, transaction) { return getEvaluation(ctx, id, transaction); }

  list(ctx, filters, transaction) { return listEvaluations(ctx, filters, transaction); }

  homologate(ctx, id, data, transaction) { return homologateEvaluation(ctx, id, data, transaction); }

  processQueued(ctx, transaction, options) { return processQueued(ctx, transaction, options); }

  feedback(ctx, runId, body, transaction) { return recordFeedback(ctx, runId, body, transaction); }

  listCandidates(ctx, filters, transaction) { return listCandidates(ctx, filters, transaction); }

  approveCandidate(ctx, id, data, transaction) { return decideCandidate(ctx, id, 'APPROVED', data, transaction); }

  rejectCandidate(ctx, id, data, transaction) { return decideCandidate(ctx, id, 'REJECTED', data, transaction); }
}

module.exports = { AiEvaluationService };
