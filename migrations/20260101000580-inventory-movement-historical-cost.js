'use strict';

/**
 * Revisão Marco 7 (19/10/2026), item A1 — EST-011: "Custo usado na obra vem do custo
 * médio/FIFO/política definida e nunca é duplicado". O ledger de estoque não guardava o custo do
 * movimento, então a obra era recalculada com o custo médio de HOJE e o histórico mudava a cada
 * nova entrada. Passa a gravar no próprio movimento, no momento do fato:
 *   - unit_cost  numeric(18,6): custo unitário usado (custo médio do momento; na entrada por
 *                recebimento, o custo da nota);
 *   - total_cost numeric(18,2): quantidade × unit_cost;
 *   - cost_source varchar(32): de onde veio o custo — RECORDED (gravado no fato, código novo),
 *                BACKFILL_RECEIPT (movimento antigo de recebimento: custo da linha da nota),
 *                BACKFILL_CURRENT_AVERAGE (movimento antigo sem custo no fato: melhor dado
 *                disponível é o custo médio atual do item na data desta migration),
 *                UNKNOWN (item sem custo médio conhecido).
 * Movimentos antigos ficam marcados para que relatórios saibam que o custo é aproximado.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE inventory.inventory_movements
               ADD COLUMN IF NOT EXISTS unit_cost numeric(18,6) NULL,
               ADD COLUMN IF NOT EXISTS total_cost numeric(18,2) NULL,
               ADD COLUMN IF NOT EXISTS cost_source varchar(32) NULL`);
    await q(`UPDATE inventory.inventory_movements m
                SET unit_cost = ri.unit_cost,
                    total_cost = round(m.quantity * ri.unit_cost, 2),
                    cost_source = 'BACKFILL_RECEIPT'
               FROM inventory.receipt_items ri
              WHERE m.cost_source IS NULL
                AND m.source_type = 'RECEIPT'
                AND m.movement_type = 'IN'
                AND ri.receipt_id = m.source_id
                AND ri.inventory_item_id = m.inventory_item_id
                AND ri.unit_cost IS NOT NULL`);
    await q(`UPDATE inventory.inventory_movements m
                SET unit_cost = i.average_cost,
                    total_cost = round(m.quantity * i.average_cost, 2),
                    cost_source = 'BACKFILL_CURRENT_AVERAGE'
               FROM inventory.inventory_items i
              WHERE m.cost_source IS NULL
                AND i.id = m.inventory_item_id
                AND i.average_cost IS NOT NULL`);
    await q(`UPDATE inventory.inventory_movements SET cost_source = 'UNKNOWN' WHERE cost_source IS NULL`);
    await q(`CREATE INDEX IF NOT EXISTS inventory_movements_project_cost_idx
               ON inventory.inventory_movements (project_id, movement_type) WHERE project_id IS NOT NULL`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS inventory.inventory_movements_project_cost_idx');
    await q(`ALTER TABLE inventory.inventory_movements
               DROP COLUMN IF EXISTS cost_source,
               DROP COLUMN IF EXISTS total_cost,
               DROP COLUMN IF EXISTS unit_cost`);
  },
};
