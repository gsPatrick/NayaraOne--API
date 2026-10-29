'use strict';

/** M9-D696 (3.3) — checks do read model rm_legal_deadlines: frescor, conciliação com a fonte, invariante, completude de `due_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_legal_deadlines', short: 'legal_deadlines', domain: 'LEGAL', metrics: ['legal.deadlines'],
  completeness: { field: 'due_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at IS NULL)::int AS nulls FROM legal.legal_deadlines WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'PENDING'` },
  invariant: { rule: 'vencidos e a vencer <= prazos abertos', violation: `overdue > open_total OR due_next_7d > open_total OR due_7_to_29d > open_total` },
});
