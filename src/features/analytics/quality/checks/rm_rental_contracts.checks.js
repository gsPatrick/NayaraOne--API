'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_contracts: frescor, conciliação com a fonte, invariante, completude de `total_value`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_contracts', short: 'rental_contracts', domain: 'RENTAL', metrics: ['rent.active_contracts'],
  completeness: { field: 'total_value', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE total_value IS NULL)::int AS nulls FROM legal.contracts WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'cada status guardado tem ao menos um contrato', violation: `count < 1` },
});
