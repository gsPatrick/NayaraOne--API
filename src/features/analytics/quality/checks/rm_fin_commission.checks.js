'use strict';

/** M9-D696 (3.3) — checks do read model rm_fin_commission: frescor, conciliação com a fonte, invariante, completude de `commission_amount`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_fin_commission', short: 'fin_commission', domain: 'CORRESPONDENT', metrics: ['cor.commission'],
  completeness: { field: 'commission_amount', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE amount IS NULL)::int AS nulls FROM correspondent.commission_entitlements WHERE company_id = :companyId AND status <> 'ADJUSTED'` },
  invariant: { rule: 'valores de comissão não negativos', violation: `expected < 0 OR confirmed < 0 OR received < 0` },
});
