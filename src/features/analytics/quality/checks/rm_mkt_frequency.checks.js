'use strict';

/** M9-D696 (3.3) — checks do read model rm_mkt_frequency: frescor, conciliação com a fonte, invariante, completude de `person_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_frequency', short: 'mkt_frequency', domain: 'MARKETING', metrics: ['mkt.frequency'],
  completeness: { field: 'person_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE person_id IS NULL)::int AS nulls FROM crm.messages WHERE company_id = :companyId AND direction = 'OUTBOUND' AND purpose IS NOT NULL` },
  invariant: { rule: 'contatos acima do teto <= contatos alcançados', violation: `contacts_over_cap > contacts_reached` },
});
