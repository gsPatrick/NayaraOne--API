'use strict';

/** M9-D696 (3.3) — checks do read model rm_mkt_campaigns: frescor, conciliação com a fonte, invariante, completude de `cost_actual`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_campaigns', short: 'mkt_campaigns', domain: 'MARKETING', metrics: ['mkt.campaigns', 'mkt.attribution', 'mkt.cost'],
  completeness: { field: 'cost_actual', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE cost_actual IS NULL)::int AS nulls FROM marketing.campaigns WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'leads atribuídos <= leads da campanha', violation: `attributed_leads > leads_total` },
});
