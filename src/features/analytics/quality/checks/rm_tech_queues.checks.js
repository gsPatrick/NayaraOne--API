'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_tech_queues: frescor, conciliação com a fonte, invariante, completude de `event_type`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tech_queues', short: 'tech_queues', domain: 'TECH_AI', metrics: ['tec.queues_dlq'],
  completeness: { field: 'event_type', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(event_type), '') IS NULL)::int AS nulls FROM integration.outbox_events WHERE company_id = :companyId AND status IN ('PENDING', 'DEAD_LETTER')` },
  invariant: { rule: 'o instante do item mais antigo existe se e só se há item aguardando', violation: `(depth = 0 AND oldest_at IS NOT NULL) OR (depth > 0 AND oldest_at IS NULL)` },
});
