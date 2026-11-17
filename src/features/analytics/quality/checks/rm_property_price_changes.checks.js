'use strict';

/** M9-D696 (3.3) — checks do read model rm_property_price_changes: frescor, conciliação com a fonte, invariante, completude de `old_price`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

// DI-BI2-7 (item 18): a criação da oferta grava a linha OFFER_CREATED sem preço anterior, de propósito (propertyOffers.service.js); o M3:143 trata da ALTERAÇÃO
// de preço, que sempre tem o preço anterior.

declareDomainChecks({
  model: 'rm_property_price_changes', short: 'price_changes', domain: 'PROPERTIES', metrics: ['prop.price_changes'],
  completeness: { field: 'old_price', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE old_price IS NULL)::int AS nulls FROM real_estate.property_price_history WHERE company_id = :companyId AND COALESCE(reason_code, '') <> 'OFFER_CREATED'` },
  invariant: { rule: 'sem mudança não há variação percentual', violation: `changes = 0 AND (change_pct_sum <> 0 OR avg_change_pct <> 0)` }, signed: ['change_pct_sum', 'avg_change_pct'],
});
