'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_repasses: frescor, conciliação com a fonte, invariante, completude de `reference_month`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_repasses', short: 'rental_repasses', domain: 'RENTAL', metrics: ['rent.repasses', 'fin.owner_repasses_pending'],
  completeness: { field: 'reference_month', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE reference_month IS NULL)::int AS nulls FROM finance.owner_repasses WHERE company_id = :companyId` },
  invariant: { rule: 'repasse em atraso é parte do pendente', violation: `overdue_count > pending_count OR overdue > pending` },
});
