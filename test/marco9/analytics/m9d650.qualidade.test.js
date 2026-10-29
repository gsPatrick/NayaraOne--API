'use strict';

// M9-D650 — regra de qualidade dos três KPIs: realizado 0% usa fator 1 (forecast = custo real + orçamento), obra sem cronograma baseline, forecast sem
// progresso medido e receita contratada zero deixam o KPI INCOMPLETE e SEM valor (nunca um número enganoso).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/obraKpiEnv');
const { at } = require('../_helpers/m9d618Obras');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

let env;
const t = () => env.tenantA;
const read = (code, key = '') => bi.readKpi(t(), code, { dimensionKey: key });
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);

before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

/** Obra de 40.000,00 aprovados, etapa medida em 0% (explícito), 5.000,00 já pagos e contrato de 50.000,00. */
async function obraZero() {
  const id = await bi.seed(env, t(), 'construction.projects', { name: 'Obra Zero', status: 'ACTIVE', starts_at: at('10-20'), ends_at_planned: at('12-20'), budget_amount: '40000.00' });
  const stage = await bi.seed(env, t(), 'construction.project_stages', { project_id: id, name: 'Única', sequence: 1, planned_cost: '40000.00', planned_pct: '10', measured_pct: '0', status: 'PENDING', ends_at: at('12-10') });
  await bi.seed(env, t(), 'finance.financial_entries', { entry_type: 'DEBIT', nature: 'PAYABLE', construction_project_id: id, amount: '5000.00', status: 'SETTLED', settled_at: at('10-25') });
  await bi.seed(env, t(), 'legal.contracts', { contract_type: 'CONSTRUCTION', construction_project_id: id, status: 'ACTIVE', total_value: '50000.00' });
  return { id, stage };
}

test('m9d650 forecast com realizado 0% usa fator 1 (custo real + orçamento) e o KPI fica OK', async () => {
  const zero = await obraZero();
  await bi.refresh(t(), [zero]);
  const out = await bi.kpis(t());
  assert.equal(out.kpis['obra.baseline_actual_forecast'].status, 'OK');
  same((await read('obra.baseline_actual_forecast')).value, '45000.00', '5.000,00 + 40.000,00 × fator 1');
  same((await read('obra.projected_margin')).value, '5000.00', '50.000,00 - 45.000,00');
  same((await read('obra.progress_vs_schedule')).value, '0.00', 'realizado 0%');
  same((await read('obra.progress_vs_schedule', 'desvio_pp')).value, '-10.00', 'planejado 10% e realizado 0%');
});

test('m9d650 receita contratada zero deixa a margem INCOMPLETE e sem valor, e o forecast segue OK', async () => {
  const semReceita = await bi.seed(env, t(), 'construction.projects', { name: 'Obra Sem Receita', status: 'ACTIVE', starts_at: at('10-01'), ends_at_planned: at('12-01'), budget_amount: '1000.00' });
  const stage = await bi.seed(env, t(), 'construction.project_stages', { project_id: semReceita, name: 'Única', sequence: 1, planned_cost: '1000.00', planned_pct: '20', measured_pct: '10', status: 'IN_PROGRESS', ends_at: at('11-20') });
  await bi.refresh(t(), [{ id: semReceita, stage }]);
  const out = await bi.kpis(t());
  assert.deepEqual([out.kpis['obra.projected_margin'].status, out.kpis['obra.projected_margin'].details.reason], ['INCOMPLETE', 'RECEITA_CONTRATADA_ZERO']);
  assert.equal(out.kpis['obra.baseline_actual_forecast'].status, 'OK');
  const margin = await read('obra.projected_margin');
  assert.deepEqual([margin.status, margin.value], ['INCOMPLETE', null], 'a tela mostra "Dado incompleto": status sem valor');
});

test('m9d650 obra.progress_vs_schedule fica INCOMPLETE com valor nulo quando a regra de qualidade falha (obra sem cronograma baseline)', async () => {
  const semEtapas = await bi.seed(env, t(), 'construction.projects', { name: 'Obra Sem Cronograma', status: 'ACTIVE', starts_at: at('10-01'), ends_at_planned: at('12-01'), budget_amount: '50000.00' });
  await bi.refresh(t(), [{ id: semEtapas }]);
  const out = await bi.kpis(t());
  assert.deepEqual([out.kpis['obra.progress_vs_schedule'].status, out.kpis['obra.progress_vs_schedule'].details.reason], ['INCOMPLETE', 'OBRA_SEM_CRONOGRAMA_BASELINE']);
  const kpi = await read('obra.progress_vs_schedule');
  assert.deepEqual([kpi.status, kpi.value], ['INCOMPLETE', null]);
  assert.ok(kpi.revisionNo >= 2, 'a revisão anterior (OK) continua gravada: snapshot é imutável');
});

test('m9d650 obra.baseline_actual_forecast fica INCOMPLETE com valor nulo quando o forecast não tem progresso medido', async () => {
  const kpi = await read('obra.baseline_actual_forecast');
  assert.deepEqual([kpi.status, kpi.value], ['INCOMPLETE', null]);
  const out = await bi.kpis(t());
  assert.equal(out.kpis['obra.baseline_actual_forecast'].details.reason, 'FORECAST_SEM_PROGRESSO_MEDIDO', 'a obra tem orçamento e nenhuma etapa medida');
});

test('m9d650 obra.projected_margin fica INCOMPLETE com valor nulo quando o forecast está INCOMPLETE', async () => {
  const kpi = await read('obra.projected_margin');
  assert.deepEqual([kpi.status, kpi.value], ['INCOMPLETE', null]);
  const out = await bi.kpis(t());
  assert.equal(out.kpis['obra.projected_margin'].details.reason, 'FORECAST_INCOMPLETO');
});

test('m9d650 sem nenhuma obra nada é inventado: o KPI da outra empresa não ganha snapshot', async () => {
  const out = await bi.kpis(env.tenantB);
  assert.deepEqual([out.written, Object.keys(out.kpis)], [0, []]);
});
