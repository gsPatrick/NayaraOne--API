'use strict';

// M9-D652 — KPIs obra.waste (desperdício) e obra.postwork_cost (custo pós-obra): reprodução a partir dos registros-fonte (centavo a centavo) e regra de
// qualidade (perda sem custo médio e caso sem obra deixam o KPI DEGRADED, sem valor).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d652Scenario');
const oracle = require('../_helpers/m9d652Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
let env;
let p1;
let waste;
let post;
const t = () => env.cX;
before(async () => {
  env = await e.setup();
  p1 = await sc.project(env, t());
  waste = await sc.seedWaste(env, t(), p1);
  post = await sc.seedPostwork(env, t(), p1);
  await sc.refreshProject(t(), p1, { movements: [waste.ids[0]], cases: [post.c1, post.c2], contract: post.contract });
});
after(() => e.teardown(env));

test('m9d652 reproduz obra.waste a partir dos registros-fonte', async () => {
  const out = await e.run(t(), 'obra');
  const want = await oracle.waste(env, t());
  assert.deepEqual([want.waste, want.consumption, want.pct], ['14000.00', '280000.00', '5.00'], 'exemplo do livro');
  const kpi = await e.readKpi(t(), 'obra.waste');
  same(kpi.value, want.waste, 'desperdício');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.valueNature], ['OK', 'BRL', 1, 'ACTUAL']);
  same((await e.readKpi(t(), 'obra.waste', { dimensionKey: 'desperdicio_pct' })).value, want.pct, 'percentual sobre o consumo');
  same((await e.readKpi(t(), 'obra.waste', { dimensionKey: 'consumo_brl' })).value, want.consumption, 'consumo');
  same((await e.readKpi(t(), 'obra.waste', { dimensionKey: `obra:${p1}` })).value, want.waste, 'por obra');
  same((await e.readKpi(t(), 'obra.waste', { dimensionKey: `material:${waste.i1}` })).value, '9000.00', 'por material');
  assert.equal((await e.readKpi(t(), 'obra.waste', { dimensionKey: 'desperdicio_pct' })).unit, 'PERCENT');
  assert.equal(out.kpis['obra.waste'].details.percent, want.pct);
});

test('m9d652 obra.waste fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const lossWithoutCost = await sc.movement(env, t(), p1, waste.i1, 'LOSS', null);
  await e.apply(t(), 'inventory.movement.recorded', { id: lossWithoutCost });
  const out = await e.run(t(), 'obra');
  assert.equal((await oracle.waste(env, t())).withoutCost, 1);
  assert.deepEqual([out.kpis['obra.waste'].status, out.kpis['obra.waste'].value, out.kpis['obra.waste'].details.reason], ['DEGRADED', null, 'PERDA_SEM_CUSTO_MEDIO']);
  const kpi = await e.readKpi(t(), 'obra.waste');
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
  assert.equal(out.kpis['obra.waste'].message, 'Dado incompleto, valor não confiável.');
});

test('m9d652 obra.waste sem consumo na obra fica INCOMPLETE com valor nulo', async () => {
  const p2 = await sc.project(env, env.cY, 'Obra sem saída');
  const i = await sc.item(env, env.cY, 'Brita');
  const loss = await sc.movement(env, env.cY, p2, i, 'LOSS', '50.00');
  await e.apply(env.cY, 'inventory.movement.recorded', { id: loss });
  const out = await e.run(env.cY, 'obra');
  assert.deepEqual([out.kpis['obra.waste'].status, out.kpis['obra.waste'].value, out.kpis['obra.waste'].details.reason], ['INCOMPLETE', null, 'SEM_CONSUMO']);
});

test('m9d652 reproduz obra.postwork_cost a partir dos registros-fonte', async () => {
  const out = await e.run(t(), 'obra');
  const want = await oracle.postwork(env, t());
  assert.deepEqual([want.realized, want.planned, want.revenue, want.pct], ['38500.00', '500.00', '1200000.00', '3.21'], 'exemplo do livro: 38.500,00 sobre 1.200.000,00');
  const kpi = await e.readKpi(t(), 'obra.postwork_cost');
  same(kpi.value, want.realized, 'custo realizado');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version], ['OK', 'BRL', 1]);
  assert.equal(out.kpis['obra.postwork_cost'].details.planned, want.planned, 'o previsto fica em separado');
  same((await e.readKpi(t(), 'obra.postwork_cost', { dimensionKey: 'custo_pct' })).value, want.pct, 'percentual da receita');
  same((await e.readKpi(t(), 'obra.postwork_cost', { dimensionKey: 'previsto_brl' })).value, want.planned, 'previsto');
  same((await e.readKpi(t(), 'obra.postwork_cost', { dimensionKey: 'causa:UMIDADE' })).value, '38500.00', 'por causa');
  same((await e.readKpi(t(), 'obra.postwork_cost', { dimensionKey: 'equipe:Equipe A' })).value, '30000.00', 'por equipe (só o realizado)');
  same((await e.readKpi(t(), 'obra.postwork_cost', { dimensionKey: 'material:Tinta' })).value, '30000.00', 'por material');
});

test('m9d652 obra.postwork_cost fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const orphan = await sc.warrantyCase(env, t(), null, { status: 'OPEN', root_cause_code: 'X', labor_cost: '10.00' });
  await e.apply(t(), 'warranty.case.opened', { id: orphan });
  const out = await e.run(t(), 'obra');
  assert.deepEqual([out.kpis['obra.postwork_cost'].status, out.kpis['obra.postwork_cost'].value, out.kpis['obra.postwork_cost'].details.reason], ['DEGRADED', null, 'OCORRENCIA_SEM_OBRA']);
  const kpi = await e.readKpi(t(), 'obra.postwork_cost');
  assert.deepEqual([kpi.status, kpi.value], ['DEGRADED', null]);
});

test('m9d652 obra.postwork_cost sem receita contratada devolve o valor e deixa o percentual nulo', async () => {
  const p = await sc.project(env, env.cY, 'Obra sem contrato');
  const c = await sc.warrantyCase(env, env.cY, p, { root_cause_code: 'X', labor_cost: '200.00' });
  await e.apply(env.cY, 'project.created', { id: p });
  await e.apply(env.cY, 'warranty.case.opened', { id: c });
  const out = await e.run(env.cY, 'obra');
  assert.deepEqual([out.kpis['obra.postwork_cost'].status, out.kpis['obra.postwork_cost'].value, out.kpis['obra.postwork_cost'].details.percent], ['OK', '200.00', null]);
});
