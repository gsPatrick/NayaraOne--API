'use strict';

/** M9-D696 (3.3) — checks do read model rm_support_complaints: frescor, conciliação com a fonte, invariante, completude de `feedback_type`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_support_complaints', short: 'support_complaints', domain: 'SUPPORT', metrics: ['sup.complaints_by_reason'],
  completeness: { field: 'feedback_type', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE type IS NULL)::int AS nulls FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'cada motivo guardado tem ao menos uma reclamação', violation: `count < 1` },
});
