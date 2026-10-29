'use strict';

/** M9-D696 (3.3) — checks do read model rm_legal_cases_risk: frescor, conciliação com a fonte, invariante, completude de `risk_level`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_legal_cases_risk', short: 'legal_cases_risk', domain: 'LEGAL', metrics: ['legal.cases_by_risk'],
  completeness: { field: 'risk_level', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(risk_level), '') IS NULL)::int AS nulls FROM legal.legal_cases WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'cada grupo guardado tem ao menos um processo', violation: `count < 1` },
});
