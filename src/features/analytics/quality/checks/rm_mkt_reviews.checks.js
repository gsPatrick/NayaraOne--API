'use strict';

/** M9-D696 (3.3) — checks do read model rm_mkt_reviews: frescor, conciliação com a fonte, invariante, completude de `platform`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_reviews', short: 'mkt_reviews', domain: 'MARKETING', metrics: ['sup.reviews'],
  completeness: { field: 'platform', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE platform IS NULL)::int AS nulls FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'COMPLETED'` },
  invariant: { rule: 'avaliações não negativas, contagem por nota fechando com o total e soma das notas entre 1 e 5 por avaliação (mês aberto sem avaliação, com zero, é válido)', violation: `reviews < 0 OR rating_1 + rating_2 + rating_3 + rating_4 + rating_5 <> reviews OR rating_sum < reviews OR rating_sum > 5 * reviews` },
});
