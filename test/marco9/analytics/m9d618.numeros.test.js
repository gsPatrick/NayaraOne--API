'use strict';

// M9-D618 — os números de cada read model contra o cálculo independente (oracle), pelos eventos reais aplicados pelo worker do BI.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d618Scenario');
const o = require('../_helpers/m9d618Oracle');

let env;
let ids;
before(async () => {
  env = await bi.setup(sc.MODELS);
  ids = await sc.seedAll(env, env.tenantA);
  await sc.applyAll(env.tenantA, ids);
});
after(() => bi.teardown(env));

const rows = (model) => bi.rowsOf(env, model, env.tenantA);
const one = async (model, projectId) => (await rows(model)).find((r) => r.project_id === projectId);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

test('m9d618 progresso: baseline e actual ponderados pelo custo planejado e previsão pelo ritmo', async () => {
  const p1 = await one('rm_project_progress', ids.p1);
  assert.equal(p1.baseline_percent, o.ratio6(38000000, 1000001), '(600000×50 + 400000×20 + 1×0) ÷ 1000001');
  assert.equal(p1.actual_percent, o.ratio6(28000000, 1000001));
  assert.equal(p1.stages_total, 3);
  assert.equal(iso(p1.baseline_finish_date), '2026-12-28');
  assert.equal(iso(p1.forecast_finish_date), o.paceFinish('2026-09-18', '2026-10-28', p1.actual_percent), 'início + teto(40 dias × 100 ÷ 27,999972)');
  assert.equal(iso(p1.forecast_finish_date), '2027-02-08');
  const p3 = await one('rm_project_progress', ids.p3);
  assert.deepEqual([p3.baseline_percent, p3.actual_percent, iso(p3.forecast_finish_date)], ['60.000000', '50.000000', '2026-11-24']);
});

test('m9d618 custo: orçamento aprovado, custo real do ledger, previsão e receita contratada', async () => {
  const p1 = await one('rm_project_cost', ids.p1);
  assert.equal(p1.budget_cost, '900000.00', 'baseline do orçamento aprovado, não o orçamento da obra');
  assert.equal(p1.actual_cost, '150000.50', 'só saídas liquidadas da obra até o fim do dia-base; terceiros, pendentes, estornos e liquidação de amanhã ficam fora');
  assert.equal(p1.forecast_cost, '798000.75', '150000,50 + 900000 × (1 − 0,27999972) × 1');
  assert.equal(p1.contract_revenue, '1500000.00', 'ativo + assinado; rascunho e rescindido fora');
  const p3 = await one('rm_project_cost', ids.p3);
  assert.deepEqual([p3.budget_cost, p3.actual_cost, p3.forecast_cost], ['100000.00', '80000.00', '160000.00'], 'sem orçamento aprovado usa o da obra; fator de desvio 1,6');
});

test('m9d618 atrasos e medições', async () => {
  const d1 = await one('rm_project_delays', ids.p1);
  assert.deepEqual(o.pick(d1, ['delayed_stages', 'max_delay_days', 'delay_days_sum', 'stages_without_date']), { delayed_stages: 1, max_delay_days: 8, delay_days_sum: 8, stages_without_date: 1 });
  assert.deepEqual(o.pick(await one('rm_project_delays', ids.p3), ['delayed_stages', 'max_delay_days']), { delayed_stages: 0, max_delay_days: 0 });
  const m = await one('rm_project_measurements', ids.p1);
  assert.deepEqual([m.measured_value, m.approved_value, m.pending_value, iso(m.oldest_pending_since)], ['240000.00', '180000.00', '60000.00', '2026-10-05']);
  assert.equal(await one('rm_project_measurements', ids.p3), undefined, 'obra sem medição não tem linha (nenhum zero inventado)');
});

test('m9d618 não conformidades por causa e equipe, com NAO_INFORMADA e a janela de 30 dias', async () => {
  const got = o.byKey(await rows('rm_project_nonconformities'), ['cause', 'team_id']);
  assert.equal(got.size, 3);
  assert.deepEqual(o.pick(got.get('MATERIAL|Equipe A'), ['open', 'closed_30d', 'close_days_sum']), { open: 1, closed_30d: 1, close_days_sum: 10 }, 'a fechada em 01/09 fica fora');
  assert.deepEqual(o.pick(got.get('NAO_INFORMADA|NAO_INFORMADA'), ['open', 'closed_30d', 'close_days_sum']), { open: 1, closed_30d: 1, close_days_sum: 2 });
  assert.deepEqual(o.pick(got.get('PROJETO|Equipe B'), ['open', 'closed_30d', 'close_days_sum']), { open: 0, closed_30d: 1, close_days_sum: 9 }, '29/09 é o primeiro dia da janela; 28/09 fica fora');
});

test('m9d618 desperdício por material e custo pós-obra por causa, equipe e material', async () => {
  const waste = o.byKey(await rows('rm_project_waste'), ['material_id']);
  assert.deepEqual(o.pick(waste.get(ids.stock.i1), ['waste_value', 'waste_quantity', 'movements_without_cost', 'consumption_value']), { waste_value: '70.00', waste_quantity: '8.000', movements_without_cost: 1, consumption_value: '1000.00' });
  assert.deepEqual(o.pick(waste.get(ids.stock.i2), ['waste_value', 'movements_without_cost', 'consumption_value']), { waste_value: '0.00', movements_without_cost: 0, consumption_value: '400.00' });
  const post = o.byKey(await rows('rm_postwork_cost'), ['project_id', 'cause', 'team_id', 'material_id']);
  const k = (project, cause, team, material) => [project, cause, team, material].join('|');
  const f = ['cases_open', 'cases_total', 'warranty_cost'];
  assert.deepEqual(o.pick(post.get(k(ids.p1, 'UMIDADE', 'Equipe A', 'Tinta')), f), { cases_open: 1, cases_total: 1, warranty_cost: '230.00' });
  assert.deepEqual(o.pick(post.get(k(ids.p1, 'UMIDADE', 'Equipe B', 'NAO_INFORMADA')), f), { cases_open: 1, cases_total: 1, warranty_cost: '10.00' });
  assert.deepEqual(o.pick(post.get(k(ids.p1, 'UMIDADE', 'NAO_INFORMADA', 'NAO_INFORMADA')), f), { cases_open: 0, cases_total: 0, warranty_cost: '150.00' }, 'mão de obra e material do próprio caso, sem contar o caso duas vezes');
  assert.deepEqual(o.pick(post.get(k(ids.p1, 'NAO_INFORMADA', 'NAO_INFORMADA', 'NAO_INFORMADA')), f), { cases_open: 0, cases_total: 1, warranty_cost: '0.00' }, 'caso fechado sem causa');
  assert.deepEqual(o.pick(post.get(k('00000000-0000-0000-0000-000000000000', 'X', 'NAO_INFORMADA', 'NAO_INFORMADA')), f), { cases_open: 1, cases_total: 1, warranty_cost: '0.00' }, 'caso sem obra vai para a obra zero');
});

test('m9d618 estoque e ferramentas', async () => {
  const [inv] = await rows('rm_inventory_health');
  assert.deepEqual(o.pick(inv, ['stock_value', 'items_below_min', 'ruptures', 'losses_30d', 'items_without_min', 'items_without_cost']),
    { stock_value: '762.50', items_below_min: 2, ruptures: 1, losses_30d: '165.00', items_without_min: 1, items_without_cost: 1 });
  assert.equal(iso(inv.as_of_date), '2026-10-28');
  const [tools] = await rows('rm_tool_assets');
  assert.deepEqual(o.pick(tools, ['loans_open', 'loans_overdue', 'loans_without_due_date', 'assets_in_maintenance']), { loans_open: 4, loans_overdue: 2, loans_without_due_date: 1, assets_in_maintenance: 2 });
});
