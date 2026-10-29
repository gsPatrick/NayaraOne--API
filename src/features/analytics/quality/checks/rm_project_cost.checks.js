'use strict';

/** M9-D696 (3.3) — checks do read model rm_project_cost: frescor, conciliação com a fonte, invariante, completude de `baseline_amount`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_cost', short: 'project_cost', domain: 'CONSTRUCTION', metrics: ['obra.projected_margin', 'obra.baseline_actual_forecast'],
  completeness: { field: 'baseline_amount', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE baseline_amount IS NULL)::int AS nulls FROM construction.budgets WHERE company_id = :companyId AND deleted_at IS NULL AND approved_at IS NOT NULL` },
  invariant: { rule: 'custos e receita não negativos', violation: `budget_cost < 0 OR actual_cost < 0 OR forecast_cost < 0 OR contract_revenue < 0` },
  signed: ['projected_margin'], // a margem projetada (receita menos forecast) é negativa quando a obra projeta prejuízo (M9-D650); as demais colunas seguem >= 0
});
