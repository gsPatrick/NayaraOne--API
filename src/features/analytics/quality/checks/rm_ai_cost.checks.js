'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_ai_cost: frescor, conciliação com a fonte, invariante, completude de `cost_amount`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_ai_cost', short: 'ai_cost', domain: 'TECH_AI', metrics: ['ai.cost_by_agent', 'ai.budget'],
  completeness: { field: 'cost_amount', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE cost_amount IS NULL)::int AS nulls FROM ai.ai_runs WHERE company_id = :companyId AND status = 'COMPLETED' AND routing_path IN ('SMALL_MODEL', 'ADVANCED_MODEL')` },
  invariant: { rule: 'orçamento mensal, quando existe, é positivo', violation: `budget_brl IS NOT NULL AND budget_brl <= 0` },
});
