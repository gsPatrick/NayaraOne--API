'use strict';

/**
 * M9-D618 — read model rm_project_waste (schema analytics): por obra e material, o desperdício (baixas de tipo PERDA valoradas pelo custo gravado
 * no movimento, que é o custo médio do dia da baixa), a quantidade, quantas baixas ficaram sem custo (o KPI marca DEGRADED, M9-D652) e o consumo
 * valorizado da obra (saídas) para o percentual. Só ids de item e valores. O agregado é a obra: o recálculo troca todas as linhas dela.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { WASTE_EVENTS } = require('./obra.events');
const { projectAggregateKey, allProjectKeys } = require('./obra.resolve');

async function recompute({ companyId, key, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT m.inventory_item_id::text AS material_id,
            COALESCE(SUM(m.total_cost) FILTER (WHERE m.movement_type = 'LOSS'), 0)::text AS waste_value,
            COALESCE(SUM(m.quantity) FILTER (WHERE m.movement_type = 'LOSS'), 0)::text AS waste_quantity,
            (count(*) FILTER (WHERE m.movement_type = 'LOSS' AND m.total_cost IS NULL))::int AS movements_without_cost,
            COALESCE(SUM(m.total_cost) FILTER (WHERE m.movement_type = 'OUT'), 0)::text AS consumption_value
       FROM inventory.inventory_movements m
      WHERE m.company_id = :companyId AND m.project_id = :projectId AND m.movement_type IN ('LOSS', 'OUT')
      GROUP BY m.inventory_item_id ORDER BY 1`,
    { replacements: { companyId, projectId: key.project_id }, transaction }
  );
  return { rows: rows.map(({ material_id: materialId, ...fields }) => ({ key: { material_id: materialId }, fields })) };
}

const def = registerReadModel({
  name: 'rm_project_waste',
  version: 1,
  keyColumns: ['project_id', 'material_id'],
  aggregateColumns: ['project_id'],
  eventTypes: [...WASTE_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  rebuild: { keys: allProjectKeys },
});

module.exports = { def, recompute };
