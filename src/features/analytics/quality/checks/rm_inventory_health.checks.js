'use strict';

/** M9-D696 (3.3) — checks do read model rm_inventory_health: frescor, conciliação com a fonte, invariante, completude de `item_cost`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_inventory_health', short: 'inventory_health', domain: 'INVENTORY', metrics: ['inv.stock_value', 'inv.below_minimum', 'inv.losses'],
  completeness: { field: 'item_cost', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE average_cost IS NULL)::int AS nulls FROM inventory.inventory_items WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACTIVE'` },
  invariant: { rule: 'rupturas <= itens abaixo do mínimo', violation: `ruptures > items_below_min` },
});
