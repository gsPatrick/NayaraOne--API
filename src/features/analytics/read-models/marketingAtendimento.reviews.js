'use strict';

/**
 * M9-D627 — avaliações públicas e satisfação, lidas de marketing.review_requests (M9-D424):
 *  rm_mkt_reviews           por mês e plataforma: avaliações COMPLETED com public_rating preenchido e a soma das notas
 *  rm_support_satisfaction  por mês: respostas de satisfação (satisfaction_score preenchido) e a soma das notas
 * O mês é o da conclusão (completed_at; sem ela, a última alteração). O catálogo do Marketing não tem evento de conclusão: a avaliação
 * concluída e a nota entram pela agenda; review.requested (e o caso de atendimento aberto, para a satisfação) abrem o mês no read model.
 * M9-D672: rm_mkt_reviews guarda também a contagem por nota (rating_1 a rating_5) e rm_support_satisfaction as respostas com nota 4 ou 5 (positive).
 * Pedido ainda sem plataforma fica na plataforma "SEM_PLATAFORMA". Nenhuma pessoa entra aqui, só contagem e soma.
 */
const { sqlMonth, TZ, monthKey, rows } = require('./marketingAtendimento.time');

const NO_PLATFORM = 'SEM_PLATAFORMA';
const RATINGS = [1, 2, 3, 4, 5]; // M9-D672: contagem por nota (rating_1 a rating_5)
const DONE = `COALESCE(completed_at, updated_at)`;

const reviewsKey = (event) => ({ month: monthKey(event.occurredAt), platform: NO_PLATFORM });

async function reviewsRecompute({ companyId, key, transaction }) {
  const [r] = await rows(
    `SELECT count(*)::int AS reviews, COALESCE(sum(public_rating), 0)::int AS rating_sum, ${RATINGS.map((n) => `count(*) FILTER (WHERE public_rating = ${n})::int AS rating_${n}`).join(', ')} FROM marketing.review_requests
      WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'COMPLETED' AND public_rating IS NOT NULL
        AND COALESCE(platform, :none) = :platform AND ${sqlMonth(DONE)} = :month`,
    { ...TZ, companyId, platform: key.platform, month: key.month, none: NO_PLATFORM }, transaction
  );
  return { fields: { reviews: r.reviews, rating_sum: r.rating_sum, ...Object.fromEntries(RATINGS.map((n) => [`rating_${n}`, r[`rating_${n}`]])) } };
}

const reviewsKeysSql = (filter) => `
  SELECT ${sqlMonth(DONE)} AS month, COALESCE(platform, :none) AS platform FROM marketing.review_requests
   WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'COMPLETED' AND public_rating IS NOT NULL ${filter}
  UNION
  SELECT ${sqlMonth('created_at')} AS month, :none AS platform FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL ${filter}
  ORDER BY 1, 2`;

const reviewsScheduled = ({ companyId, now, windowDays, limit, transaction }) => rows(
  `${reviewsKeysSql('AND updated_at >= :since')} LIMIT :limit`, { ...TZ, companyId, none: NO_PLATFORM, since: new Date(now.getTime() - windowDays * 86400000), limit: limit || 5000 }, transaction);
const reviewsRebuild = ({ companyId, transaction }) => rows(reviewsKeysSql(''), { ...TZ, companyId, none: NO_PLATFORM }, transaction);

const satisfactionKey = (event) => ({ month: monthKey(event.occurredAt) });

async function satisfactionRecompute({ companyId, key, transaction }) {
  const [r] = await rows(
    `SELECT count(*)::int AS responses, COALESCE(sum(satisfaction_score), 0)::int AS score_sum, count(*) FILTER (WHERE satisfaction_score >= 4)::int AS positive FROM marketing.review_requests
      WHERE company_id = :companyId AND deleted_at IS NULL AND satisfaction_score IS NOT NULL AND ${sqlMonth(DONE)} = :month`,
    { ...TZ, companyId, month: key.month }, transaction
  );
  return { fields: { responses: r.responses, score_sum: r.score_sum, positive: r.positive } };
}

const satisfactionKeysSql = (filter) => `
  SELECT ${sqlMonth(DONE)} AS month FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL AND satisfaction_score IS NOT NULL ${filter}
  UNION
  SELECT ${sqlMonth('created_at')} AS month FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL ${filter}
  UNION
  SELECT ${sqlMonth('created_at')} AS month FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL ${filter}
  ORDER BY 1`;

const satisfactionScheduled = ({ companyId, now, windowDays, limit, transaction }) => rows(
  `${satisfactionKeysSql('AND updated_at >= :since')} LIMIT :limit`, { ...TZ, companyId, since: new Date(now.getTime() - windowDays * 86400000), limit: limit || 5000 }, transaction);
const satisfactionRebuild = ({ companyId, transaction }) => rows(satisfactionKeysSql(''), { ...TZ, companyId }, transaction);

const reviews = {
  name: 'rm_mkt_reviews', keyColumns: ['month', 'platform'], eventTypes: ['review.requested'], aggregateKey: reviewsKey, recompute: reviewsRecompute,
  scheduledKeys: reviewsScheduled, rebuildKeys: reviewsRebuild,
};
const satisfaction = {
  name: 'rm_support_satisfaction', keyColumns: ['month'], eventTypes: ['review.requested', 'crm.feedback_case.created'], aggregateKey: satisfactionKey, recompute: satisfactionRecompute,
  scheduledKeys: satisfactionScheduled, rebuildKeys: satisfactionRebuild,
};

module.exports = { reviews, satisfaction, NO_PLATFORM };
