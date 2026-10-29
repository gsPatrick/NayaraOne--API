'use strict';

/** M9-D696 (3.3) — checks do read model rm_project_measurements: frescor, conciliação com a fonte, invariante, completude de `total_amount`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_measurements', short: 'project_measurements', domain: 'CONSTRUCTION', metrics: ['obra.measurements'],
  completeness: { field: 'total_amount', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE total_amount IS NULL)::int AS nulls FROM construction.stage_measurements WHERE company_id = :companyId` },
  invariant: { rule: 'valores medidos não negativos', violation: `measured_value < 0 OR approved_value < 0 OR pending_value < 0` },
});
