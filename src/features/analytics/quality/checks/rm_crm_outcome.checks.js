'use strict';

/** M9-D696 (3.3) — checks do read model rm_crm_outcome: frescor, conciliação com a fonte, invariante, completude de `closed_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_crm_outcome', short: 'crm_outcome', domain: 'CRM', metrics: ['crm.opportunities_won', 'crm.loss_reasons', 'crm.conversion_rate'],
  completeness: { field: 'closed_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE closed_at IS NULL)::int AS nulls FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage IN ('WON','LOST','WITHDRAWN')` },
  invariant: { rule: 'linha de totais (motivo vazio) não traz perda por motivo; linha de motivo não traz totais', violation: `(lost_reason = '' AND lost_count <> 0) OR (lost_reason <> '' AND (won + lost + withdrawn) <> 0)` },
});
