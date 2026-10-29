'use strict';

/** M9-D671 (3.3) — checks do read model rm_mkt_optout_month: frescor, conciliação com a fonte, invariante, completude de `created_at` dos pedidos de saída, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_optout_month', short: 'mkt_optout_month', domain: 'MARKETING', metrics: ['mkt.opt_out'],
  completeness: { field: 'created_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at IS NULL)::int AS nulls FROM marketing.suppression_list WHERE company_id = :companyId AND reason = 'OPT_OUT' AND deleted_at IS NULL` },
  invariant: { rule: 'contatos alcançados, pedidos de saída e pedidos sem data não negativos', violation: `reached < 0 OR opt_outs < 0 OR undated < 0` },
});
