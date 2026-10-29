'use strict';

/** M9-D696 (3.3) — checks do read model rm_project_delays: frescor, conciliação com a fonte, invariante, completude de `ends_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_delays', short: 'project_delays', domain: 'CONSTRUCTION', metrics: ['obra.delays'],
  completeness: { field: 'ends_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE ends_at IS NULL)::int AS nulls FROM construction.project_stages WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'maior atraso <= soma dos atrasos', violation: `max_delay_days > delay_days_sum` },
});
