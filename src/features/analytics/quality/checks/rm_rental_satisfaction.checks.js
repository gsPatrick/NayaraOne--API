'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_satisfaction: frescor, conciliação com a fonte, invariante, completude de `person_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_satisfaction', short: 'rental_satisfaction', domain: 'RENTAL', metrics: ['rent.satisfaction'],
  completeness: { field: 'person_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE person_id IS NULL)::int AS nulls FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'cada mês guardado tem ao menos uma resposta', violation: `responses < 1` }, signed: ['score_sum'],
});
