'use strict';

/** M9-D696 (3.3) — checks do read model rm_mkt_reviews: frescor, conciliação com a fonte, invariante, completude de `platform`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_reviews', short: 'mkt_reviews', domain: 'MARKETING', metrics: ['sup.reviews'],
  completeness: { field: 'platform', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE platform IS NULL)::int AS nulls FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'COMPLETED'` },
  invariant: { rule: 'cada mês e plataforma guardados têm ao menos uma avaliação', violation: `reviews < 1` },
});
