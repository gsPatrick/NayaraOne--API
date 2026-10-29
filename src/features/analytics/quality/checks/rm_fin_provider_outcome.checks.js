'use strict';

/** M9-D696 (3.3) — checks do read model rm_fin_provider_outcome: frescor, conciliação com a fonte, invariante, completude de `provider_code`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_fin_provider_outcome', short: 'fin_provider_outcome', domain: 'CORRESPONDENT', metrics: ['cor.approval_rate_by_provider', 'cor.analysis_time'],
  completeness: { field: 'provider_code', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(provider_code), '') IS NULL)::int AS nulls FROM correspondent.financing_cases WHERE company_id = :companyId` },
  invariant: { rule: 'análises medidas <= decisões (aprovadas + reprovadas)', violation: `analysis_count > approved + rejected` },
});
