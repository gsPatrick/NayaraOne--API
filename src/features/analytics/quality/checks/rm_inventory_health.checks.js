'use strict';

/** M9-D696 (3.3) — checks do read model rm_inventory_health: frescor, conciliação com a fonte, invariante, completude de `item_cost`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

// DI-BI2-7 (item 10): o único lugar que grava o custo médio é o recebimento confirmado (receipts.service.js, EST-011; M7:82 "Entrada confirmada atualiza saldo e
// custo"). Item sem recebimento COMPLETED ainda não tem custo a medir, e item de serviço não tem estoque.
const RECEIVED = `item_type <> 'SERVICE_ITEM' AND EXISTS (
  SELECT 1 FROM inventory.receipt_items ri JOIN inventory.receipts r ON r.id = ri.receipt_id AND r.company_id = ri.company_id
   WHERE ri.company_id = inventory_items.company_id AND ri.inventory_item_id = inventory_items.id AND r.status = 'COMPLETED')`;

declareDomainChecks({
  model: 'rm_inventory_health', short: 'inventory_health', domain: 'INVENTORY', metrics: ['inv.stock_value', 'inv.below_minimum', 'inv.losses'],
  completeness: { field: 'item_cost', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE average_cost IS NULL)::int AS nulls FROM inventory.inventory_items WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACTIVE' AND ${RECEIVED}` },
  invariant: { rule: 'rupturas <= itens abaixo do mínimo', violation: `ruptures > items_below_min` },
});
