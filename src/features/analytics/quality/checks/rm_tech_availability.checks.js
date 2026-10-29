'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_tech_availability: frescor, conciliação com a fonte, invariante, completude de `probe`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_tech_availability', short: 'tech_availability', domain: 'TECH_AI', metrics: ['tec.availability'],
  completeness: { field: 'probe', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE probe IS NULL)::int AS nulls FROM analytics.tech_signal_log WHERE kind = 'PROBE'` },
  invariant: { rule: 'sondas bem-sucedidas <= sondas feitas <= sondas esperadas', violation: `up > checks OR checks > expected` },
});
