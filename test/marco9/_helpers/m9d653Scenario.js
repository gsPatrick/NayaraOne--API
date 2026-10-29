'use strict';

// Cenários da M9-D653, data-base 28/10/2026 (quarta-feira, São Paulo). Estoque: 120 un a 3,50 + 40 un a 12,00 = 900,00; 2 itens abaixo do mínimo (1 em
// ruptura). Perdas: 1.800,00 (custo do movimento) + 650,00 (estimado) = 2.450,00 em 2 casos, mais 1 caso aberto. Ferramentas: 2 empréstimos em atraso de 5 abertos
// e 2 patrimônios com manutenção aberta. Cada cenário também grava o que NÃO deve entrar (ferramenta, item inativo, perda rejeitada ou fora da janela).
const e = require('./m9d652Env');

const at = (date, hour = 15) => `${date}T${String(hour).padStart(2, '0')}:00:00Z`;
const item = (env, t, extra) => e.seed(env, t, 'inventory.inventory_items', { name: 'Item', item_type: 'CONSUMABLE', status: 'ACTIVE', ...extra });
const balance = (env, t, itemId, quantity, location = '11111111-1111-4111-8111-111111111111') => e.seed(env, t, 'inventory.stock_balances', { inventory_item_id: itemId, location_id: location, quantity_on_hand: quantity });

/** Saldos: A (120 un a 3,50, mínimo 100), B (40 un a 12,00, mínimo 50: abaixo), C (zero, mínimo 10: ruptura). Fora: ferramenta, item inativo e item excluído. */
async function seedStock(env, t) {
  const a = await item(env, t, { name: 'Cimento', minimum_quantity: '100', average_cost: '3.50' });
  await balance(env, t, a, '120');
  const b = await item(env, t, { name: 'Tinta', minimum_quantity: '50', average_cost: '12.00' });
  await balance(env, t, b, '40');
  const c = await item(env, t, { name: 'Areia', minimum_quantity: '10', average_cost: '5.00' });
  await balance(env, t, c, '0');
  await balance(env, t, await item(env, t, { name: 'Furadeira', item_type: 'TOOL', minimum_quantity: '5', average_cost: '300.00' }), '1');
  await balance(env, t, await item(env, t, { name: 'Antigo', status: 'INACTIVE', minimum_quantity: '5', average_cost: '9.00' }), '50');
  await balance(env, t, await item(env, t, { name: 'Excluído', deleted_at: at('2026-10-01'), minimum_quantity: '5', average_cost: '9.00' }), '50');
  return { a, b, c };
}

const lossCase = (env, t, itemId, extra) => e.seed(env, t, 'inventory.loss_cases', { context: 'Perda no canteiro', inventory_item_id: itemId, ...extra });

/** Perdas: 1.800,00 pelo movimento (o estimado é 1.700,00) e 650,00 estimado; fora: rejeitada, decidida há 30 dias e uma ainda aberta. */
async function seedLosses(env, t, itemId) {
  const mv = await e.seed(env, t, 'inventory.inventory_movements', { inventory_item_id: itemId, movement_type: 'LOSS', quantity: '3', total_cost: '1800.00', moved_at: at('2026-10-20') });
  await lossCase(env, t, itemId, { status: 'APPROVED', decided_at: at('2026-10-20'), resulting_movement_id: mv, estimated_cost: '1700.00' });
  await lossCase(env, t, itemId, { status: 'APPROVED', decided_at: at('2026-10-10'), estimated_cost: '650.00' });
  await lossCase(env, t, itemId, { status: 'REJECTED', decided_at: at('2026-10-20'), estimated_cost: '800.00' });
  await lossCase(env, t, itemId, { status: 'APPROVED', decided_at: at('2026-09-28'), estimated_cost: '700.00' }); // fora da janela de 30 dias
  await lossCase(env, t, itemId, { status: 'OPEN', estimated_cost: '99.00' });
  return mv;
}

const asset = (env, t) => e.seed(env, t, 'inventory.assets', { name: 'Furadeira', status: 'AVAILABLE' });
const loan = (env, t, assetId, extra) => e.seed(env, t, 'inventory.tool_loans', { asset_id: assetId, person_user_id: t.userId, ...extra });

/** Empréstimos: 5 abertos, 2 em atraso (27/10 e 20/10), 1 vence hoje e 1 amanhã; 1 devolvido. Manutenção aberta em 2 patrimônios (3 ordens). */
async function seedTools(env, t) {
  const [a1, a2, a3, a4, a5] = [await asset(env, t), await asset(env, t), await asset(env, t), await asset(env, t), await asset(env, t)];
  await loan(env, t, a1, { status: 'OPEN', due_at: '2026-10-27' });
  await loan(env, t, a2, { status: 'OVERDUE', due_at: '2026-10-20' });
  await loan(env, t, a3, { status: 'OPEN', due_at: '2026-10-28' });
  await loan(env, t, a4, { status: 'OPEN', due_at: '2026-10-29' });
  await loan(env, t, a5, { status: 'OPEN', due_at: '2026-11-15' });
  await loan(env, t, a1, { status: 'RETURNED', due_at: '2026-09-01', returned_at: at('2026-09-02') });
  await e.seed(env, t, 'inventory.maintenance_orders', { asset_id: a1, status: 'OPEN', opened_at: at('2026-10-01') });
  await e.seed(env, t, 'inventory.maintenance_orders', { asset_id: a1, status: 'OPEN', opened_at: at('2026-10-02') });
  await e.seed(env, t, 'inventory.maintenance_orders', { asset_id: a2, status: 'OPEN', opened_at: at('2026-10-03') });
  await e.seed(env, t, 'inventory.maintenance_orders', { asset_id: a3, status: 'CLOSED', opened_at: at('2026-10-04'), closed_at: at('2026-10-05') });
  return { a1, a2, a3 };
}

/** Atualiza os read models de Estoque e Patrimônio da empresa (um evento de estoque e um de ferramenta). */
async function refresh(t) {
  await e.apply(t, 'inventory.stock.low', {});
  await e.apply(t, 'tool.loan.created', {});
}

module.exports = { at, item, balance, lossCase, seedStock, seedLosses, asset, loan, seedTools, refresh };
