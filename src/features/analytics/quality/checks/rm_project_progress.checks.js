'use strict';

/** M9-D696 (3.3) — checks do read model rm_project_progress: frescor, conciliação com a fonte, invariante, completude de `planned_end_date`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_progress', short: 'project_progress', domain: 'CONSTRUCTION', metrics: ['obra.progress_vs_schedule', 'obra.baseline_actual_forecast'],
  completeness: { field: 'planned_end_date', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE ends_at_planned IS NULL)::int AS nulls FROM construction.projects WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'percentuais entre 0 e 100', violation: `baseline_percent < 0 OR baseline_percent > 100 OR actual_percent < 0 OR actual_percent > 100` },
});
