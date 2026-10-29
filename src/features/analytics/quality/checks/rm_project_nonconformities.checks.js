'use strict';

/** M9-D696 (3.3) — checks do read model rm_project_nonconformities: frescor, conciliação com a fonte, invariante, completude de `cause_code`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_nonconformities', short: 'project_nonconf', domain: 'CONSTRUCTION', metrics: ['obra.nonconformities', 'obra.recurrence'],
  completeness: { field: 'cause_code', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(cause_code), '') IS NULL)::int AS nulls FROM construction.nonconformities WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'abertas e fechadas não negativas', violation: `open < 0 OR closed_30d < 0` },
});
