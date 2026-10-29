'use strict';

/** M9-D696 (3.3) — checks do read model rm_broker_performance: frescor, conciliação com a fonte, invariante, completude de `created_by`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_broker_performance', short: 'broker_perf', domain: 'CRM', metrics: ['crm.broker_capture', 'crm.broker_conversion'],
  completeness: { field: 'created_by', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_by IS NULL)::int AS nulls FROM real_estate.properties WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'mês no formato AAAA-MM', violation: `month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'` },
});
