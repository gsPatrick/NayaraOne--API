'use strict';

/** M9-D696 (3.3) — checks do read model rm_mkt_delivery: frescor, conciliação com a fonte, invariante, completude de `channel`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_delivery', short: 'mkt_delivery', domain: 'MARKETING', metrics: ['mkt.deliverability', 'mkt.opt_out'],
  completeness: { field: 'channel', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE channel IS NULL)::int AS nulls FROM crm.messages WHERE company_id = :companyId AND direction = 'OUTBOUND'` },
  invariant: { rule: 'entregues e falhas <= enviadas', violation: `delivered > sent OR failed > sent` },
});
