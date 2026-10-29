'use strict';

/** M9-D696 (3.3) — checks do read model rm_crm_visits_proposals: frescor, conciliação com a fonte, invariante, completude de `scheduled_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_crm_visits_proposals', short: 'crm_visits', domain: 'CRM', metrics: ['crm.visits', 'crm.proposals'],
  completeness: { field: 'scheduled_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE scheduled_at IS NULL)::int AS nulls FROM crm.visits WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'visitas realizadas <= visitas agendadas', violation: `visits_done > visits_scheduled` },
});
