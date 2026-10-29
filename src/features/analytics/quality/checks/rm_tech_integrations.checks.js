'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_tech_integrations: frescor, conciliação com a fonte, invariante, completude de `family`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tech_integrations', short: 'tech_integrations', domain: 'TECH_AI', metrics: ['tec.integration_errors'],
  completeness: { field: 'family', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(p.domain), '') IS NULL)::int AS nulls FROM integration.connections c JOIN integration.providers p ON p.code = c.provider_code WHERE c.company_id = :companyId AND c.status = 'ACTIVE'` },
  invariant: { rule: 'erros <= chamadas e taxa de sucesso só existe com chamadas', violation: `errors > calls OR (success_rate IS NOT NULL AND calls = 0)` },
});
