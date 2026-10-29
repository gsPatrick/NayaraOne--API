'use strict';

/** M9-D696 (3.3) — checks do read model rm_mkt_automation: frescor, conciliação com a fonte, invariante, completude de `started_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_mkt_automation', short: 'mkt_automation', domain: 'MARKETING', metrics: ['mkt.automations_blocked_failed'],
  completeness: { field: 'started_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE started_at IS NULL)::int AS nulls FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'execuções, bloqueios e falhas não negativos', violation: `executed < 0 OR blocked < 0 OR failed < 0` },
});
