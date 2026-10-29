'use strict';

/** M9-D696 (3.3) — checks do read model rm_crm_lead_daily: frescor, conciliação com a fonte, invariante, completude de `lead_source`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_crm_lead_daily', short: 'crm_lead_daily', domain: 'CRM', metrics: ['crm.leads_by_origin', 'crm.first_response_time'],
  completeness: { field: 'lead_source', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(lead_source), '') IS NULL)::int AS nulls FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'primeiras respostas <= leads', violation: `first_response_count > leads` },
});
