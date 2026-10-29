'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_arrears: frescor, conciliação com a fonte, invariante, completude de `due_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_arrears', short: 'rental_arrears', domain: 'RENTAL', metrics: ['rent.delinquency'],
  completeness: { field: 'due_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at IS NULL)::int AS nulls FROM finance.financial_entries WHERE company_id = :companyId AND nature = 'RECEIVABLE' AND status = 'PENDING'` },
  invariant: { rule: 'em atraso = dentro da janela + fora da janela; contagem >= 0', violation: `overdue_count < 0 OR overdue_amount <> overdue_amount_in_window_90d + overdue_amount_outside_window_90d` },
});
