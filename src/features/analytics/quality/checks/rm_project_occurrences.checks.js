'use strict';

/** M9-D696 (3.3) / M9-D652 — checks do read model rm_project_occurrences: frescor, conciliação com a fonte, invariante, completude de `cause_code` das não conformidades, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_project_occurrences', short: 'project_occurrences', domain: 'CONSTRUCTION', metrics: ['obra.recurrence'],
  completeness: { field: 'cause_code', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(cause_code), '') IS NULL)::int AS nulls FROM construction.nonconformities WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'custo e lista de equipes e de materiais válidos', violation: `cost < 0 OR jsonb_typeof(teams) <> 'array' OR jsonb_typeof(materials) <> 'array'` },
});
