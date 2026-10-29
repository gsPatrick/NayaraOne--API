'use strict';

/** M9-D696 (3.3) — checks do read model rm_property_portfolio: frescor, conciliação com a fonte, invariante, completude de `availability_status`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_property_portfolio', short: 'property_portfolio', domain: 'PROPERTIES', metrics: ['prop.active_properties', 'prop.without_sale_by_period'],
  completeness: { field: 'availability_status', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE availability_status IS NULL)::int AS nulls FROM real_estate.properties WHERE company_id = :companyId AND deleted_at IS NULL` },
  invariant: { rule: 'faixa de dias sem venda só existe para imóvel disponível', violation: `(status <> 'AVAILABLE') <> (no_sale_days_bucket = 'NAO_SE_APLICA')` },
});
