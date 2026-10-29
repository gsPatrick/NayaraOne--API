'use strict';

/** M9-D696 (3.3) — checks do read model rm_radar_matches: frescor, conciliação com a fonte, invariante, completude de `property_id`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_radar_matches', short: 'radar_matches', domain: 'CRM', metrics: ['radar.matches'],
  completeness: { field: 'property_id', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE payload_json->>'propertyId' IS NULL)::int AS nulls FROM integration.outbox_events WHERE company_id = :companyId AND event_type = 'radar.matched'` },
  invariant: { rule: 'convertidos <= cruzamentos', violation: `converted > matches` },
});
