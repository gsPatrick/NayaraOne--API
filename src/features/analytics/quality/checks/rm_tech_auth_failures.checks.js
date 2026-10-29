'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_tech_auth_failures: frescor, conciliação com a fonte, invariante, completude de `kind`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tech_auth_failures', short: 'tech_auth_failures', domain: 'TECH_AI', metrics: ['tec.auth_failures'],
  completeness: { field: 'kind', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(error_code), '') IS NULL)::int AS nulls FROM integration.integration_errors WHERE company_id = :companyId AND error_class = 'AUTH'` },
  invariant: { rule: 'pico por hora <= falhas do dia e atores distintos <= falhas', violation: `failures < 1 OR peak_hour_failures > failures OR peak_hour_failures < 1 OR distinct_actors > failures` },
});
