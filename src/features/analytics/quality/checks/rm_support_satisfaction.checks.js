'use strict';

/** M9-D696 (3.3) — checks do read model rm_support_satisfaction: frescor, conciliação com a fonte, invariante, completude de `satisfaction_score`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_support_satisfaction', short: 'support_satisfaction', domain: 'SUPPORT', metrics: ['sup.satisfaction'],
  completeness: { field: 'satisfaction_score', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE satisfaction_score IS NULL)::int AS nulls FROM marketing.review_requests WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'COMPLETED'` },
  invariant: { rule: 'cada mês guardado tem ao menos uma resposta', violation: `responses < 1` }, signed: ['score_sum'],
});
