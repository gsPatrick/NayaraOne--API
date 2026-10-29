'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_vacancy: frescor, conciliação com a fonte, invariante, completude de `availability_status`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_vacancy', short: 'rental_vacancy', domain: 'RENTAL', metrics: ['rent.vacancy'],
  completeness: { field: 'availability_status', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE availability_status IS NULL)::int AS nulls FROM real_estate.properties WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'alugados + suspensos + vagos = total locável', violation: `rented_total + suspended_total + vacant_total <> rentable_total` },
});
