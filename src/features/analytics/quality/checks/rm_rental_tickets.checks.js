'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_tickets: frescor, conciliação com a fonte, invariante, completude de `property_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_tickets', short: 'rental_tickets', domain: 'RENTAL', metrics: ['rent.tickets'],
  completeness: { field: 'property_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE property_id IS NULL)::int AS nulls FROM construction.maintenance_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'sem chamado resolvido não há horas de resolução', violation: `closed = 0 AND resolution_hours_sum <> 0` },
});
