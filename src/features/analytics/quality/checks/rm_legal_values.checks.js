'use strict';

/** M9-D696 (3.3) — checks do read model rm_legal_values: frescor, conciliação com a fonte, invariante, completude de `estimated_amount`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_legal_values', short: 'legal_values', domain: 'LEGAL', metrics: ['legal.values'],
  completeness: { field: 'estimated_amount', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE estimated_amount IS NULL)::int AS nulls FROM legal.legal_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'valores e processos sem valor não negativos', violation: `cases_without_value < 0` },
});
