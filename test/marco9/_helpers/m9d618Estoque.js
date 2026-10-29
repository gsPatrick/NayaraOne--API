'use strict';

// Fontes de estoque e patrimônio para os testes da M9-D618. Data-base 28/10/2026 (SP).
const bi = require('./biObrasJuridicoEnv');
const { at } = require('./m9d618Obras');
const { item } = require('./m9d618Pos');

/** Estoque da empresa: valor 762,50; abaixo do mínimo 2; ruptura 1; sem mínimo 1; sem custo médio 1 (ferramenta, inativo e excluído ficam fora). */
async function estoque(env, t) {
  const loc1 = bi.uuid();
  const loc2 = bi.uuid();
  const balance = (inventory_item_id, location_id, quantity_on_hand) => bi.seed(env, t, 'inventory.stock_balances', { inventory_item_id, location_id, quantity_on_hand });
  const i1 = await item(env, t, { name: 'Cimento', minimum_quantity: '100', average_cost: '10.00' });
  await balance(i1, loc1, '60');
  await balance(i1, loc2, '10');
  const i2 = await item(env, t, { name: 'Areia', minimum_quantity: '10', average_cost: '5.00' });
  await balance(i2, loc1, '0');
  const i3 = await item(env, t, { name: 'Brita', average_cost: '2.50' });
  await balance(i3, loc1, '25');
  const i4 = await item(env, t, { name: 'Prego', minimum_quantity: '5' });
  await balance(i4, loc1, '8');
  await balance(await item(env, t, { name: 'Furadeira', item_type: 'TOOL', minimum_quantity: '5', average_cost: '300.00' }), loc1, '1');
  await balance(await item(env, t, { name: 'Antigo', status: 'INACTIVE', minimum_quantity: '5', average_cost: '9.00' }), loc1, '50');
  await balance(await item(env, t, { name: 'Excluído', deleted_at: at('10-01'), minimum_quantity: '5', average_cost: '9.00' }), loc1, '50');
  return { i1, i2, i3, i4 };
}

/** Perdas decididas: 120,00 (custo do movimento), 40,00 (estimado, sem movimento) e 5,00 (1º dia da janela) = 165,00; rejeitada e antiga ficam fora. */
async function perdas(env, t, i1) {
  const mv = await bi.seed(env, t, 'inventory.inventory_movements', { inventory_item_id: i1, movement_type: 'LOSS', quantity: '12', total_cost: '120.00', moved_at: at('10-20') });
  const base = { context: 'Perda no canteiro', inventory_item_id: i1 };
  await bi.seed(env, t, 'inventory.loss_cases', { ...base, status: 'APPROVED', decided_at: at('10-20'), resulting_movement_id: mv, estimated_cost: '99.00' });
  await bi.seed(env, t, 'inventory.loss_cases', { ...base, status: 'APPROVED', decided_at: at('10-10'), estimated_cost: '40.00' });
  await bi.seed(env, t, 'inventory.loss_cases', { ...base, status: 'APPROVED', decided_at: at('09-29'), estimated_cost: '5.00' });
  await bi.seed(env, t, 'inventory.loss_cases', { ...base, status: 'APPROVED', decided_at: at('09-28'), estimated_cost: '700.00' });
  await bi.seed(env, t, 'inventory.loss_cases', { ...base, status: 'REJECTED', decided_at: at('10-20'), estimated_cost: '800.00' });
}

/** Ferramentas: 4 empréstimos abertos (2 em atraso, 1 sem data), 1 devolvido; 2 patrimônios com manutenção aberta (3 ordens). */
async function ferramentas(env, t) {
  const asset = () => bi.seed(env, t, 'inventory.assets', { name: 'Furadeira', status: 'AVAILABLE' });
  const [a1, a2, a3, a4] = [await asset(), await asset(), await asset(), await asset()];
  const loan = (asset_id, extra) => bi.seed(env, t, 'inventory.tool_loans', { asset_id, person_user_id: t.userId, ...extra });
  await loan(a1, { status: 'OPEN', due_at: '2026-10-27' });
  await loan(a2, { status: 'OVERDUE', due_at: '2026-10-20' });
  await loan(a3, { status: 'OPEN', due_at: '2026-10-28' });
  await loan(a4, { status: 'OPEN' });
  await loan(a1, { status: 'RETURNED', due_at: '2026-09-01', returned_at: at('09-02') });
  await bi.seed(env, t, 'inventory.maintenance_orders', { asset_id: a1, status: 'OPEN', opened_at: at('10-01') });
  await bi.seed(env, t, 'inventory.maintenance_orders', { asset_id: a1, status: 'OPEN', opened_at: at('10-02') });
  await bi.seed(env, t, 'inventory.maintenance_orders', { asset_id: a2, status: 'OPEN', opened_at: at('10-03') });
  await bi.seed(env, t, 'inventory.maintenance_orders', { asset_id: a3, status: 'CLOSED', opened_at: at('10-04'), closed_at: at('10-05') });
  return { a1, a2, a3, a4 };
}

module.exports = { estoque, perdas, ferramentas };
