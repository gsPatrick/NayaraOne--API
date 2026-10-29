'use strict';

/** M9-D696 (3.3) — checks do read model rm_support_sla: frescor, conciliação com a fonte, invariante, completude de `sla_due_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_support_sla', short: 'support_sla', domain: 'SUPPORT', metrics: ['sup.sla_resolution'],
  completeness: { field: 'sla_due_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE sla_due_at IS NULL)::int AS nulls FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'resolvidas dentro do prazo <= resolvidas', violation: `within_sla > resolved` },
});
