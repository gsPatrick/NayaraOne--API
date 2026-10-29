'use strict';

/**
 * M9-D618 — read model rm_inventory_health (schema analytics): uma linha por empresa e data-base com o valor em estoque (Σ saldo × custo médio),
 * os itens abaixo do mínimo, as rupturas e as perdas dos últimos 30 dias, mais os itens sem mínimo e sem custo médio (o KPI marca DEGRADED, M9-D653).
 * Entram os itens ativos dos tipos do parâmetro analytics.estoque.tipos_item (padrão CONSUMABLE; ferramentas e patrimônio estão em rm_tool_assets).
 * Abaixo do mínimo = saldo total < mínimo; ruptura = item com mínimo definido e saldo <= 0. Perda = caso de perda decidido como perda (APPROVED) na
 * janela de 30 dias (data-base inclusive, SP), pelo custo do movimento de baixa, ou o estimado se a baixa não tem custo. Depende do relógio.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { STOCK_EVENTS } = require('./obra.events');
const { readItemTypes } = require('./obra.settings');
const { asOfAggregateKey, asOfScheduledKeys } = require('./asOf.keys');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

async function recompute({ companyId, groupId, asOfDate, transaction }) {
  const types = await readItemTypes({ companyId, groupId }, transaction);
  const [[stock]] = await sequelize.query(
    `WITH it AS (
       SELECT i.minimum_quantity AS min_qty, i.average_cost AS cost,
              COALESCE((SELECT SUM(b.quantity_on_hand) FROM inventory.stock_balances b WHERE b.company_id = :companyId AND b.inventory_item_id = i.id), 0) AS qty
         FROM inventory.inventory_items i
        WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.status = 'ACTIVE' AND i.item_type IN (:types))
     SELECT ROUND(COALESCE(SUM(qty * COALESCE(cost, 0)), 0), 2)::text AS stock_value,
            (count(*) FILTER (WHERE min_qty IS NOT NULL AND qty < min_qty))::int AS items_below_min,
            (count(*) FILTER (WHERE min_qty IS NOT NULL AND min_qty > 0 AND qty <= 0))::int AS ruptures,
            (count(*) FILTER (WHERE min_qty IS NULL))::int AS items_without_min,
            (count(*) FILTER (WHERE qty > 0 AND cost IS NULL))::int AS items_without_cost
       FROM it`,
    { replacements: { companyId, types }, transaction }
  );
  const [[loss]] = await sequelize.query(
    `SELECT ROUND(COALESCE(SUM(COALESCE(mv.total_cost, lc.estimated_cost, 0)), 0), 2)::text AS losses_30d
       FROM inventory.loss_cases lc LEFT JOIN inventory.inventory_movements mv ON mv.id = lc.resulting_movement_id AND mv.company_id = :companyId
      WHERE lc.company_id = :companyId AND lc.status = 'APPROVED' AND lc.decided_at IS NOT NULL
        AND (lc.decided_at AT TIME ZONE :tz)::date BETWEEN CAST(:asOf AS date) - 29 AND CAST(:asOf AS date)`,
    { replacements: { companyId, asOf: asOfDate, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { fields: { ...stock, ...loss } };
}

const def = registerReadModel({
  name: 'rm_inventory_health',
  version: 1,
  keyColumns: ['as_of_date'],
  eventTypes: [...STOCK_EVENTS],
  aggregateKey: asOfAggregateKey,
  recompute,
  scheduled: { keys: asOfScheduledKeys },
  rebuild: { keys: asOfScheduledKeys },
});

module.exports = { def, recompute };
