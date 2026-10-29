'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_obligations: frescor, conciliação com a fonte, invariante, completude de `contract_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_rental_obligations', short: 'rental_obligations', domain: 'RENTAL', metrics: ['rent.obligations_pending'],
  completeness: { field: 'contract_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE contract_id IS NULL)::int AS nulls FROM legal.contract_requirements WHERE company_id = :companyId AND status = 'PENDING'` },
  invariant: { rule: 'vencidas <= pendentes', violation: `overdue > pending` },
});
