'use strict';

/**
 * M9-D652 — KPI obra.postwork_cost (Custo pós-obra), versão 1. Custo realizado da garantia das obras: Σ do custo (mão de obra e material do caso mais o
 * custo de cada ação de garantia) dos casos já ENCERRADOS, e, em separado, o previsto: o custo dos casos ainda abertos, que pode crescer. Percentual =
 * realizado ÷ receita contratada das obras com caso × 100, 2 casas, uma só vez. Natureza ACTUAL. Entrada (rm_postwork_cost e a receita do rm_project_cost):
 * { noProject, rows: [{ projectId, cause, team, material, cases, cost, openCost }], revenue: { obra: receita } }. Regra de qualidade: caso sem obra
 * vinculada (obra "zero" do read model) -> DEGRADED, sem valor. Sem receita contratada, o valor sai e o percentual fica nulo (DI-D652-2).
 */
const money = require('./money');
const { degraded, sumMoney, groupSum, byKey } = require('./_obraEstoqueKpi');

const realizedOf = (r) => money.sub(r.cost || 0, r.openCost || 0);

function dimensionsOf(prefix, rows, keyOf) {
  return byKey(groupSum(rows, keyOf, realizedOf)).map(([key, value]) => ({ key: `${prefix}:${key}`, value: money.money(value) }));
}

function compute(input) {
  const rows = input.rows || [];
  const real = rows.filter((r) => r.projectId !== input.noProject);
  const realized = money.sum(real.map(realizedOf));
  const planned = sumMoney(real.map((r) => r.openCost));
  const projects = [...new Set(real.map((r) => r.projectId))].sort();
  const revenue = sumMoney(projects.map((id) => (input.revenue || {})[id]));
  const pct = money.percent(realized, revenue);
  const byProject = groupSum(real, (r) => r.projectId, realizedOf);
  const dimensions = [
    ...byKey(byProject).flatMap(([id, value]) => {
      const p = money.percent(value, (input.revenue || {})[id] || 0);
      return [{ key: `obra:${id}`, value: money.money(value) }, ...(p.value === null ? [] : [{ key: `obra:${id}:custo_pct`, value: p.value }])];
    }),
    ...dimensionsOf('causa', real, (r) => r.cause), ...dimensionsOf('equipe', real, (r) => r.team), ...dimensionsOf('material', real, (r) => r.material),
    { key: 'previsto_brl', value: money.money(planned) }, { key: 'receita_brl', value: money.money(revenue) },
    ...(pct.value === null ? [] : [{ key: 'custo_pct', value: pct.value }]),
  ];
  const details = { planned: money.money(planned), revenue: money.money(revenue), percent: pct.value, withoutProjectCases: money.count(money.sum(rows.filter((r) => r.projectId === input.noProject).map((r) => r.cases || 0))) };
  if (details.withoutProjectCases !== '0') return degraded('OCORRENCIA_SEM_OBRA', details, dimensions);
  return { value: money.money(realized), status: 'OK', details, dimensions };
}

const NIL = '00000000-0000-0000-0000-000000000000';
const row = (projectId, cause, team, material, cost, openCost = '0', cases = 1) => ({ projectId, cause, team, material, cost, openCost, cases });
const NI = 'NAO_INFORMADA';
const dims = (...list) => list.map(([key, value]) => ({ key, value }));
const okOf = (value, planned, revenue, percent, dimensions) => ({ value, status: 'OK', details: { planned, revenue, percent, withoutProjectCases: '0' }, dimensions });

const testCases = [
  { kind: 'empty', name: 'nenhum caso de garantia: zero, sem percentual', input: { noProject: NIL, rows: [], revenue: {} }, expected: okOf('0.00', '0.00', '0.00', null, dims(['previsto_brl', '0.00'], ['receita_brl', '0.00'])) },
  {
    kind: 'single', name: 'um caso encerrado de 1.000,00 em obra de 100.000,00 = 1,00%', input: { noProject: NIL, rows: [row('p1', 'UMIDADE', 'Equipe A', 'Tinta', '1000.00')], revenue: { p1: '100000.00' } },
    expected: okOf('1000.00', '0.00', '100000.00', '1.00', dims(['obra:p1', '1000.00'], ['obra:p1:custo_pct', '1.00'], ['causa:UMIDADE', '1000.00'], ['equipe:Equipe A', '1000.00'], ['material:Tinta', '1000.00'], ['previsto_brl', '0.00'], ['receita_brl', '100000.00'], ['custo_pct', '1.00'])),
  },
  {
    kind: 'typical', name: 'exemplo do livro: custo de 38.500,00 sobre receita de 1.200.000,00 = 3,21%; o caso aberto de 4.000,00 fica no previsto', input: { noProject: NIL, rows: [row('p1', 'UMIDADE', 'Equipe A', 'Tinta', '38500.00'), row('p1', 'ELETRICA', NI, NI, '4000.00', '4000.00')], revenue: { p1: '1200000.00' } },
    expected: okOf('38500.00', '4000.00', '1200000.00', '3.21', dims(['obra:p1', '38500.00'], ['obra:p1:custo_pct', '3.21'], ['causa:ELETRICA', '0.00'], ['causa:UMIDADE', '38500.00'], ['equipe:Equipe A', '38500.00'], [`equipe:${NI}`, '0.00'], [`material:${NI}`, '0.00'], ['material:Tinta', '38500.00'], ['previsto_brl', '4000.00'], ['receita_brl', '1200000.00'], ['custo_pct', '3.21'])),
  },
  {
    kind: 'period_edge', name: 'caso sem obra vinculada: DEGRADED e sem valor', input: { noProject: NIL, rows: [row('p1', 'A', NI, NI, '10.00'), row(NIL, 'B', NI, NI, '5.00')], revenue: { p1: '100.00' } },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'OCORRENCIA_SEM_OBRA', planned: '0.00', revenue: '100.00', percent: '10.00', withoutProjectCases: '1' }, dimensions: dims(['obra:p1', '10.00'], ['obra:p1:custo_pct', '10.00'], ['causa:A', '10.00'], [`equipe:${NI}`, '10.00'], [`material:${NI}`, '10.00'], ['previsto_brl', '0.00'], ['receita_brl', '100.00'], ['custo_pct', '10.00']) },
  },
  {
    kind: 'rounding', name: 'o percentual arredonda uma só vez, meio para cima (1 de 3 = 33,33%); obra sem receita deixa o percentual nulo', input: { noProject: NIL, rows: [row('p1', 'A', NI, NI, '1.00'), row('p2', 'A', NI, NI, '1.00')], revenue: { p1: '3.00' } },
    expected: okOf('2.00', '0.00', '3.00', '66.67', dims(['obra:p1', '1.00'], ['obra:p1:custo_pct', '33.33'], ['obra:p2', '1.00'], ['causa:A', '2.00'], [`equipe:${NI}`, '2.00'], [`material:${NI}`, '2.00'], ['previsto_brl', '0.00'], ['receita_brl', '3.00'], ['custo_pct', '66.67'])),
  },
];

module.exports = { id: 'obra.postwork_cost', version: 1, compute, testCases };
