'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_inspections_keys: frescor, conciliação com a fonte, invariante, completude de `contract_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_inspections_keys', short: 'rental_insp_keys', domain: 'RENTAL', metrics: ['rent.inspections_keys'],
  completeness: { field: 'contract_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE contract_id IS NULL)::int AS nulls FROM legal.inspections WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'vistorias e chaves não negativas', violation: `inspections_pending < 0 OR inspections_done < 0 OR keys_out < 0 OR keys_overdue < 0` },
});
