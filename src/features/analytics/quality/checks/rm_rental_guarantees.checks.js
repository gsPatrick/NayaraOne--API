'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_guarantees: frescor, conciliação com a fonte, invariante, completude de `ends_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_guarantees', short: 'rental_guarantees', domain: 'RENTAL', metrics: ['rent.guarantees_expiring'],
  completeness: { field: 'ends_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE ends_at IS NULL)::int AS nulls FROM legal.guarantees WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACTIVE'` },
  invariant: { rule: 'vencendo em 30 dias <= vencendo em 60 dias', violation: `expiring_30d > expiring_60d` },
});
