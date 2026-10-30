'use strict';

const repo = require('./review.repository');
const { auditReview } = require('./review.audit');
const { parseScore } = require('./review.classify');
const { reviewNotFound, reviewNotRequested, reviewRatingInvalid } = require('./review.errors');

const REQUESTED = ['SENT', 'DELIVERED'];

/**
 * Retorno da plataforma de avaliação (webhook configurado no framework de Integrações): grava a plataforma, a nota pública (1 a 5) e a data, e conclui o pedido (COMPLETED).
 * É a ÚNICA origem da nota pública que o KPI sup.reviews lê. Só pedido SENT ou DELIVERED recebe retorno (sem envio não há o que concluir); o mesmo retorno repetido não muda nada.
 */
async function recordPlatformReturn({ tenant, transaction, actor, reviewRequestId, platform, rating, completedAt }) {
  const row = await repo.findOne(reviewRequestId, transaction, true);
  if (!row) throw reviewNotFound();
  const score = parseScore(rating);
  if (score === null) throw reviewRatingInvalid({ rating });
  if (row.status === 'COMPLETED') return { reviewRequestId: row.id, replay: true, publicRating: row.public_rating };
  if (!REQUESTED.includes(row.status)) throw reviewNotRequested({ status: row.status });
  const after = await repo.update(row.id, { status: 'COMPLETED', platform: String(platform || row.platform || '').toUpperCase().slice(0, 40) || null, publicRating: score, completedAt: completedAt ? new Date(completedAt) : new Date() }, actor, transaction);
  await auditReview(tenant, actor, 'marketing.review_request.completed', row, after, `Retorno da plataforma ${after.platform || ''}: nota pública ${score}.`, transaction);
  return { reviewRequestId: row.id, replay: false, publicRating: score };
}

module.exports = { recordPlatformReturn };
