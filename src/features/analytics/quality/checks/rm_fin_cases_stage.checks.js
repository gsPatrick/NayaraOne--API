'use strict';

/** M9-D696 (3.3) — checks do read model rm_fin_cases_stage: frescor, conciliação com a fonte, invariante, completude de `provider_code`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_fin_cases_stage', short: 'fin_cases_stage', domain: 'CORRESPONDENT', metrics: ['cor.cases_by_stage'],
  completeness: { field: 'provider_code', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE provider_code IS NULL)::int AS nulls FROM correspondent.financing_cases WHERE company_id = :companyId` },
  invariant: { rule: 'cada estágio guardado tem ao menos um caso', violation: `count < 1` },
});
