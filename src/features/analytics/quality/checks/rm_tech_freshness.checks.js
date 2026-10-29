'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_tech_freshness: frescor, conciliação com a fonte, invariante, completude de `last_snapshot_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tech_freshness', short: 'tech_freshness', domain: 'TECH_AI', metrics: ['tec.freshness'],
  completeness: { field: 'last_snapshot_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE source_snapshot_at IS NULL)::int AS nulls FROM analytics.read_model_refreshes WHERE company_id = :companyId AND status IN ('SUCCEEDED', 'DEGRADED')` },
  invariant: { rule: 'estado UNKNOWN se e só se nunca houve atualização', violation: `(state = 'UNKNOWN') <> (last_snapshot_at IS NULL)` },
});
