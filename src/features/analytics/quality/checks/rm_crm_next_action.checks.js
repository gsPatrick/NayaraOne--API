'use strict';

/** M9-D696 (3.3) — checks do read model rm_crm_next_action: frescor, conciliação com a fonte, invariante, completude de `next_action`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_crm_next_action', short: 'crm_next_action', domain: 'CRM', metrics: ['crm.portfolio_without_next_action'],
  completeness: { field: 'next_action', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(COALESCE(next_action, '')), '') IS NULL)::int AS nulls FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage NOT IN ('WON','LOST','WITHDRAWN')` },
  invariant: { rule: 'sem próxima ação <= carteira em andamento', violation: `without_next_action > open_total` },
});
