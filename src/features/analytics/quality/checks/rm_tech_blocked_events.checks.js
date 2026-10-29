'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_tech_blocked_events: frescor, conciliação com a fonte, invariante, completude de `reason`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tech_blocked_events', short: 'tech_blocked_events', domain: 'TECH_AI', metrics: ['tec.blocked_events'],
  completeness: { field: 'reason', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(blocked_reason), '') IS NULL)::int AS nulls FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'BLOCKED'` },
  invariant: { rule: 'cada grupo guardado tem ao menos um evento bloqueado', violation: `blocked < 1` },
});
