'use strict';

/** M9-D696 (3.3) — checks do read model rm_postwork_cost: frescor, conciliação com a fonte, invariante, completude de `root_cause_code`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_postwork_cost', short: 'postwork_cost', domain: 'CONSTRUCTION', metrics: ['obra.postwork_cost'],
  completeness: { field: 'root_cause_code', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(root_cause_code), '') IS NULL)::int AS nulls FROM construction.maintenance_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'casos abertos <= casos totais', violation: `cases_open > cases_total` },
});
