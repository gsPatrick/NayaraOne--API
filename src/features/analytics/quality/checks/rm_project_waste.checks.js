'use strict';

/** M9-D696 (3.3) — checks do read model rm_project_waste: frescor, conciliação com a fonte, invariante, completude de `total_cost`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_waste', short: 'project_waste', domain: 'CONSTRUCTION', metrics: ['obra.waste'],
  completeness: { field: 'total_cost', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE total_cost IS NULL)::int AS nulls FROM inventory.inventory_movements WHERE company_id = :companyId AND movement_type = 'LOSS'` },
  invariant: { rule: 'perda sem custo é contada, nunca negativa', violation: `movements_without_cost < 0` },
});
