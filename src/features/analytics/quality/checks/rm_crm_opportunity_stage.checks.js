'use strict';

/** M9-D696 (3.3) — checks do read model rm_crm_opportunity_stage: frescor, conciliação com a fonte, invariante, completude de `broker_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_crm_opportunity_stage', short: 'crm_opp_stage', domain: 'CRM', metrics: ['crm.opportunities_by_stage'],
  completeness: { field: 'broker_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE owner_user_id IS NULL)::int AS nulls FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage NOT IN ('WON','LOST','WITHDRAWN')` },
  invariant: { rule: 'paradas <= em andamento no estágio', violation: `stalled_count > count` },
});
