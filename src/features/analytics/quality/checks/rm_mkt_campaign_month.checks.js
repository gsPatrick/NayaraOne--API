'use strict';

/** M9-D670 (3.3) — checks do read model rm_mkt_campaign_month: frescor, conciliação com a fonte, invariante, completude de `settled_at` das despesas liquidadas, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_campaign_month', short: 'mkt_campaign_month', domain: 'MARKETING', metrics: ['mkt.cost', 'mkt.leads', 'mkt.attribution'],
  completeness: { field: 'settled_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE settled_at IS NULL)::int AS nulls FROM finance.financial_entries WHERE company_id = :companyId AND status = 'SETTLED' AND entry_type = 'DEBIT'` },
  invariant: { rule: 'leads atribuídos pelo último toque <= leads do mês', violation: `leads_last > leads_total` },
});
