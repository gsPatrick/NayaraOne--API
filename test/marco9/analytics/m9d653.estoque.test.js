'use strict';

// M9-D653 — KPIs inv.stock_value, inv.below_minimum, inv.losses e inv.tools_overdue: reprodução a partir dos registros-fonte (centavo a centavo / unidade a
// unidade), regra de qualidade (DEGRADED, sem valor) e o fuso de São Paulo na janela das perdas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d653Scenario');
const oracle = require('../_helpers/m9d653Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
let env;
let stock;
let tools;
const T = () => env.cX;
before(async () => {
  env = await e.setup();
  stock = await sc.seedStock(env, T());
  await sc.seedLosses(env, T(), stock.a);
  tools = await sc.seedTools(env, T());
  await sc.refresh(T());
});
after(() => e.teardown(env));

const dim = async (code, key) => String(Number((await e.readKpi(T(), code, { dimensionKey: key })).value)); // numeric(20,4): "2.0000" é 2

test('m9d653 reproduz inv.stock_value a partir dos registros-fonte', async () => {
  const out = await e.run(T(), 'inv');
  const want = await oracle.stock(env, T());
  assert.equal(want.value, '900.00', 'exemplo do livro: 120 × 3,50 + 40 × 12,00');
  const kpi = await e.readKpi(T(), 'inv.stock_value');
  same(kpi.value, want.value, 'valor em estoque');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.valueNature], ['OK', 'BRL', 1, 'ACTUAL']);
  assert.equal(out.kpis['inv.stock_value'].details.itemsWithoutCost, '0');
});

test('m9d653 inv.stock_value fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const noCost = await sc.item(env, T(), { name: 'Sem custo', minimum_quantity: '1' });
  await sc.balance(env, T(), noCost, '7');
  await e.apply(T(), 'inventory.stock.low', {});
  const out = await e.run(T(), 'inv');
  assert.equal((await oracle.stock(env, T())).noCost, 1);
  assert.deepEqual([out.kpis['inv.stock_value'].status, out.kpis['inv.stock_value'].value, out.kpis['inv.stock_value'].details.reason], ['DEGRADED', null, 'ITEM_COM_SALDO_SEM_CUSTO_MEDIO']);
  const kpi = await e.readKpi(T(), 'inv.stock_value');
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
  await e.update(env, 'inventory.inventory_items', noCost, { average_cost: '1.00' });
  await e.apply(T(), 'inventory.stock.low', {});
  assert.equal((await e.run(T(), 'inv')).kpis['inv.stock_value'].status, 'OK', 'corrigido o custo, volta ao normal');
});

test('m9d653 reproduz inv.below_minimum a partir dos registros-fonte', async () => {
  await e.run(T(), 'inv');
  const want = await oracle.stock(env, T());
  assert.deepEqual([want.below, want.ruptures], [2, 1], 'Tinta (40 de 50) e Areia (zero de 10)');
  const kpi = await e.readKpi(T(), 'inv.below_minimum');
  assert.deepEqual([kpi.status, kpi.unit], ['OK', 'COUNT']);
  same(kpi.value, String(want.below), 'abaixo do mínimo');
  assert.equal(await dim('inv.below_minimum', 'rupturas_qtd'), String(want.ruptures));
});

test('m9d653 inv.below_minimum fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const noMin = await sc.item(env, T(), { name: 'Sem mínimo', average_cost: '2.00' });
  await sc.balance(env, T(), noMin, '3');
  await e.apply(T(), 'inventory.stock.low', {});
  const out = await e.run(T(), 'inv');
  assert.equal((await oracle.stock(env, T())).noMin, 1);
  assert.deepEqual([out.kpis['inv.below_minimum'].status, out.kpis['inv.below_minimum'].value, out.kpis['inv.below_minimum'].details.noMinimum], ['DEGRADED', null, '1']);
  const kpi = await e.readKpi(T(), 'inv.below_minimum');
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
  await e.update(env, 'inventory.inventory_items', noMin, { minimum_quantity: '1' });
  await e.apply(T(), 'inventory.stock.low', {});
  assert.equal((await e.run(T(), 'inv')).kpis['inv.below_minimum'].status, 'OK');
});

test('m9d653 reproduz inv.losses a partir dos registros-fonte', async () => {
  await e.run(T(), 'inv');
  const want = await oracle.losses(env, T(), e.AS_OF);
  assert.deepEqual([want.total, want.n, want.open], ['2450.00', 2, 1], 'exemplo do livro: 1.800,00 + 650,00 = 2.450,00');
  const kpi = await e.readKpi(T(), 'inv.losses');
  same(kpi.value, want.total, 'perdas');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'BRL', 1]);
  assert.equal(await dim('inv.losses', 'casos_qtd'), String(want.n));
  assert.equal(await dim('inv.losses', 'abertos_qtd'), String(want.open), 'os casos abertos ficam em separado');
});

test('m9d653 inv.losses fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const noValue = await sc.lossCase(env, T(), stock.a, { status: 'APPROVED', decided_at: sc.at('2026-10-25') });
  await e.apply(T(), 'inventory.stock.low', {});
  const out = await e.run(T(), 'inv');
  assert.equal((await oracle.losses(env, T(), e.AS_OF)).noValue, 1);
  assert.deepEqual([out.kpis['inv.losses'].status, out.kpis['inv.losses'].value, out.kpis['inv.losses'].details.reason], ['DEGRADED', null, 'PERDA_DECIDIDA_SEM_VALOR']);
  assert.deepEqual([(await e.readKpi(T(), 'inv.losses')).status, (await e.readKpi(T(), 'inv.losses')).value], ['DEGRADED', null]);
  await e.update(env, 'inventory.loss_cases', noValue, { estimated_cost: '10.00' });
  await e.apply(T(), 'inventory.stock.low', {});
  same((await e.run(T(), 'inv')).kpis['inv.losses'].value, '2460.00', 'com o valor informado a perda entra');
});

test('m9d653 reproduz inv.tools_overdue a partir dos registros-fonte', async () => {
  await e.run(T(), 'inv');
  const want = await oracle.tools(env, T(), e.AS_OF);
  assert.deepEqual([want.overdue, want.open, want.maintenance], [2, 5, 2]);
  const kpi = await e.readKpi(T(), 'inv.tools_overdue');
  assert.deepEqual([kpi.status, kpi.unit], ['OK', 'COUNT']);
  same(kpi.value, String(want.overdue), 'em atraso');
  assert.equal(await dim('inv.tools_overdue', 'abertos_qtd'), String(want.open));
  assert.equal(await dim('inv.tools_overdue', 'manutencao_qtd'), String(want.maintenance));
});

test('m9d653 inv.tools_overdue fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const noDue = await sc.loan(env, T(), tools.a3, { status: 'OPEN' });
  await e.apply(T(), 'tool.loan.created', {});
  const out = await e.run(T(), 'inv');
  assert.equal((await oracle.tools(env, T(), e.AS_OF)).noDue, 1);
  assert.deepEqual([out.kpis['inv.tools_overdue'].status, out.kpis['inv.tools_overdue'].value, out.kpis['inv.tools_overdue'].details.reason], ['DEGRADED', null, 'EMPRESTIMO_SEM_DATA_PREVISTA']);
  await e.update(env, 'inventory.tool_loans', noDue, { due_at: '2026-10-29' });
  await e.apply(T(), 'tool.loan.created', {});
  assert.equal((await e.run(T(), 'inv')).kpis['inv.tools_overdue'].value, '2');
});

test('m9d653 timezone: perda decidida às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  const it = await sc.item(env, t, { name: 'Brita', minimum_quantity: '1', average_cost: '1.00' });
  // 2026-09-29T02:30Z é 28/09 às 23:30 em São Paulo: um dia antes da janela (29/09 a 28/10); em UTC pareceria dia 29/09, dentro
  await sc.lossCase(env, t, it, { status: 'APPROVED', decided_at: '2026-09-29T02:30:00Z', estimated_cost: '500.00' });
  // 2026-10-29T02:30Z é 28/10 às 23:30 em São Paulo: ainda é o dia-base
  await sc.lossCase(env, t, it, { status: 'APPROVED', decided_at: '2026-10-29T02:30:00Z', estimated_cost: '70.00' });
  await sc.refresh(t);
  const out = await e.run(t, 'inv');
  same(out.kpis['inv.losses'].value, '70.00', 'só a de 28/10 (SP) entra');
  same((await oracle.losses(env, t, e.AS_OF)).total, '70.00', 'a fonte, por data de São Paulo, diz o mesmo');
});
