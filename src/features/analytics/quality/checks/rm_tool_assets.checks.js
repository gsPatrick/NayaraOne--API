'use strict';

/** M9-D696 (3.3) — checks do read model rm_tool_assets: frescor, conciliação com a fonte, invariante, completude de `due_date`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tool_assets', short: 'tool_assets', domain: 'INVENTORY', metrics: ['inv.tools_overdue'],
  completeness: { field: 'due_date', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at IS NULL)::int AS nulls FROM inventory.tool_loans WHERE company_id = :companyId AND status IN ('OPEN', 'OVERDUE')` },
  invariant: { rule: 'atrasados e sem prazo <= empréstimos abertos', violation: `loans_overdue > loans_open OR loans_without_due_date > loans_open` },
});
