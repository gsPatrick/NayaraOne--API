'use strict';

// Fontes de desperdício e pós-obra para os testes da M9-D618 (obra P1 da fixture m9d618Obras).
const bi = require('./biObrasJuridicoEnv');
const { at } = require('./m9d618Obras');

async function item(env, t, extra = {}) {
  return bi.seed(env, t, 'inventory.inventory_items', { name: 'Cimento', item_type: 'CONSUMABLE', status: 'ACTIVE', ...extra });
}

/** Desperdício e consumo de P1: item i1 perdeu 5 (50,00) + 2 (20,00) + 1 sem custo; consumiu 1.000,00; i2 só consumiu 400,00. */
async function movimentos(env, t, p1, i1, i2) {
  const base = { project_id: p1, moved_at: at('10-12') };
  const ids = [];
  const rows = [
    { inventory_item_id: i1, movement_type: 'LOSS', quantity: '5', total_cost: '50.00' }, { inventory_item_id: i1, movement_type: 'LOSS', quantity: '2', total_cost: '20.00' },
    { inventory_item_id: i1, movement_type: 'LOSS', quantity: '1' }, { inventory_item_id: i1, movement_type: 'OUT', quantity: '100', total_cost: '1000.00' },
    { inventory_item_id: i1, movement_type: 'IN', quantity: '300', total_cost: '3000.00' }, { inventory_item_id: i2, movement_type: 'OUT', quantity: '200', total_cost: '400.00' },
  ];
  for (const r of rows) ids.push(await bi.seed(env, t, 'inventory.inventory_movements', { ...base, ...r }));
  return ids;
}

/** Pós-obra de P1: C1 aberto com 3 ações; C2 fechado sem ação nem causa; C3 sem obra. */
async function garantias(env, t, p1) {
  const property = bi.uuid();
  const c1 = await bi.seed(env, t, 'construction.maintenance_cases', { property_id: property, project_id: p1, description: 'Infiltração', status: 'OPEN', root_cause_code: 'umidade', labor_cost: '100.00', material_cost: '50.00' });
  const action = (extra) => bi.seed(env, t, 'construction.warranty_actions', { warranty_case_id: c1, description: 'Reparo', performed_at: at('10-20'), ...extra });
  await action({ assigned_team: 'Equipe A', material_used: 'Tinta', cost: '200.00' });
  await action({ assigned_team: 'Equipe A', material_used: 'Tinta', cost: '30.00' });
  await action({ assigned_team: 'Equipe B', cost: '10.00' });
  const c2 = await bi.seed(env, t, 'construction.maintenance_cases', { property_id: property, project_id: p1, description: 'Trinca', status: 'CLOSED' });
  const c3 = await bi.seed(env, t, 'construction.maintenance_cases', { property_id: property, description: 'Sem obra', status: 'OPEN', root_cause_code: 'X' });
  return { c1, c2, c3 };
}

module.exports = { item, movimentos, garantias };
