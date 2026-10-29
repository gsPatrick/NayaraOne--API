'use strict';

// M9-D650 — os três KPIs de custo e avanço das obras recalculados do zero só com as linhas-fonte (oracle independente), o exemplo do livro, as três séries
// separadas com a natureza de cada uma, o fuso de São Paulo, o que não conta no custo real e o replay do evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d650Scenario');
const oracle = require('../_helpers/m9d650Oracle');
const asserts = require('../_helpers/readModelAsserts');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const registry = require('../../../src/features/analytics/metrics');
require('../../../src/features/analytics');

const E = scenario.EXPECTED;
let env;
let ids;
let facts;
before(async () => {
  env = await bi.setup();
  ids = await scenario.seedAll(env, env.tenantA);
  facts = await oracle.companyFacts(env, env.tenantA, bi.AS_OF);
});
after(() => bi.teardown(env));

const read = (code, key = '') => bi.readKpi(env.tenantA, code, { dimensionKey: key });
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);

test('m9d650 reproduz obra.progress_vs_schedule a partir dos registros-fonte', async () => {
  const kpi = await read('obra.progress_vs_schedule');
  assert.equal(kpi.status, 'OK');
  assert.equal(kpi.unit, 'PERCENT');
  same(kpi.value, facts.progress.actual, 'realizado% da empresa = oracle');
  same(kpi.value, E.progress.actual, 'realizado% no cenário');
  same((await read('obra.progress_vs_schedule', 'planejado_pct')).value, facts.progress.planned, 'planejado%');
  const dev = await read('obra.progress_vs_schedule', 'desvio_pp');
  same(dev.value, facts.progress.deviation, 'desvio em p.p. = oracle');
  same(dev.value, E.progress.deviation, 'desvio em p.p. no cenário');
  assert.equal(dev.unit, 'PP', 'desvio em pontos percentuais, negativo é atraso');
  const aurora = await read('obra.progress_vs_schedule', `obra:${ids.aurora.id}:desvio_pp`);
  same(aurora.value, '-8.00', 'exemplo do livro: planejado 62,00% e realizado 54,00% dão -8,00 p.p.');
});

test('m9d650 reproduz obra.baseline_actual_forecast a partir dos registros-fonte', async () => {
  const kpi = await read('obra.baseline_actual_forecast');
  assert.deepEqual([kpi.status, kpi.unit, kpi.valueNature], ['OK', 'BRL', 'PROJECTED']);
  same(kpi.value, facts.company.forecast, 'forecast da empresa');
  same(kpi.value, E.company.forecast, 'forecast da empresa no cenário');
  same((await read('obra.baseline_actual_forecast', 'baseline_brl')).value, facts.company.baseline, 'baseline');
  same((await read('obra.baseline_actual_forecast', 'actual_brl')).value, facts.company.actual, 'actual');
  for (const [name, id] of [['aurora', ids.aurora.id], ['bela', ids.bela.id]]) {
    same((await read('obra.baseline_actual_forecast', `obra:${id}:forecast_brl`)).value, E[name].forecast, `${name} forecast`);
    same((await read('obra.baseline_actual_forecast', `obra:${id}:actual_brl`)).value, E[name].actual, `${name} actual`);
    same((await read('obra.baseline_actual_forecast', `obra:${id}:baseline_brl`)).value, E[name].baseline, `${name} baseline`);
  }
});

test('m9d650 reproduz obra.projected_margin a partir dos registros-fonte', async () => {
  const kpi = await read('obra.projected_margin');
  assert.deepEqual([kpi.status, kpi.unit, kpi.valueNature, kpi.valueNatureLabel], ['OK', 'BRL', 'PROJECTED', 'Projetado']);
  same(kpi.value, facts.company.margin, 'margem da empresa');
  same((await read('obra.projected_margin', 'margem_pct')).value, facts.company.marginPct, 'margem %');
  assert.equal((await read('obra.projected_margin', 'margem_pct')).unit, 'PERCENT');
  same((await read('obra.projected_margin', 'receita_brl')).value, facts.company.revenue, 'receita contratada');
  same((await read('obra.projected_margin', `obra:${ids.aurora.id}`)).value, E.aurora.margin, 'exemplo do livro: 162.962,96');
  same((await read('obra.projected_margin', `obra:${ids.aurora.id}:margem_pct`)).value, E.aurora.marginPct, 'exemplo do livro: 13,58%');
  same((await read('obra.projected_margin', `obra:${ids.bela.id}:margem_pct`)).value, E.bela.marginPct, 'margem % da Bela Vista');
});

test('m9d650 baseline_actual_forecast mantém as três séries separadas e nunca as soma', async () => {
  const series = {};
  for (const key of ['baseline_brl', 'actual_brl', 'forecast_brl']) {
    const s = await read('obra.baseline_actual_forecast', key);
    series[key] = [s.valueNature, s.valueNatureLabel, s.value];
  }
  assert.deepEqual(series.baseline_brl.slice(0, 2), ['PLANNED', 'Previsto']);
  assert.deepEqual(series.actual_brl.slice(0, 2), ['ACTUAL', 'Realizado']);
  assert.deepEqual(series.forecast_brl.slice(0, 2), ['PROJECTED', 'Projetado']);
  same(series.baseline_brl[2], '1080000.00', 'baseline');
  same(series.actual_brl[2], '641000.00', 'actual');
  same(series.forecast_brl[2], '1199037.04', 'forecast');
  const list = registry.buildSeriesByNature(Object.entries(series).map(([key, [valueNature, , value]]) => ({ valueNature, key, value: money.money(value) })));
  assert.deepEqual(list.map((s) => [s.valueNature, s.total]), [['ACTUAL', '641000.00'], ['PLANNED', '1080000.00'], ['PROJECTED', '1199037.04']], 'cada série soma só a própria natureza');
  const main = await read('obra.baseline_actual_forecast');
  assert.notEqual(money.cmp(main.value, money.sum(Object.values(series).map(([, , v]) => v))), 0, 'o valor não é a soma das séries');
});

test('m9d650 forecast reproduz o exemplo: desvio 560.000 ÷ 529.200 sem arredondar, custo a fazer 477.037,04, forecast 1.037.037,04', async () => {
  const desvio = money.div('560000', money.div(money.mul('980000', '54'), 100));
  assert.equal(money.round(desvio, 4), '1.0582', 'desvio de custo observado');
  assert.equal(money.money(money.mul('450800', desvio)), '477037.04', 'custo a fazer = 450.800 × desvio, sem arredondar o desvio');
  const aurora = await read('obra.baseline_actual_forecast', `obra:${ids.aurora.id}:forecast_brl`);
  same(aurora.value, '1037037.04', 'forecast da Aurora');
  assert.equal(oracle.forecastOf('980000.00', '560000.00', '54.000000'), '1037037.04', 'oracle independente');
});

test('m9d650 série actual ignora saída estornada, cancelada, de terceiros, pendente e liquidada depois do dia-base', async () => {
  const actual = await read('obra.baseline_actual_forecast', `obra:${ids.aurora.id}:actual_brl`);
  same(actual.value, '560000.00', 'só as duas liquidações próprias de 400.000,00 e 160.000,00');
});

test('m9d650 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const actual = await read('obra.baseline_actual_forecast', `obra:${ids.bela.id}:actual_brl`);
  same(actual.value, '81000.00', '80.000,00 + 1.000,00 de 23:30 do dia 28 (já dia 29 em UTC); os 2.000,00 de 00:30 do dia 29 ficam para o dia seguinte');
});

test('m9d650 a leitura traz versão, frescor e rastreio até o registro de origem', async () => {
  for (const code of ['obra.progress_vs_schedule', 'obra.baseline_actual_forecast', 'obra.projected_margin']) {
    const kpi = await read(code);
    assert.equal(kpi.version, 1);
    assert.ok(kpi.sourceSnapshotAt && kpi.refreshedAt && kpi.freshness && kpi.freshness.asOfDate === bi.AS_OF, code);
    assert.equal(kpi.sourceRefs.length, 1, code);
    assert.ok(kpi.sourceRefs[0].filterHash && kpi.sourceRefs[0].filterSignature && kpi.sourceRefs[0].count >= 1, code);
  }
  assert.equal((await read('obra.baseline_actual_forecast')).sourceRefs[0].table, 'analytics.rm_project_cost');
  assert.equal((await read('obra.progress_vs_schedule')).sourceRefs[0].table, 'construction.project_stages');
});

test('m9d650 replay do mesmo evento não altera o valor', async () => {
  const event = bi.makeEvent(env.tenantA, 'finance.entry.settled', { id: ids.aurora.ledger[0] });
  const snapshot = async () => ({ cost: await bi.rowsOf(env, 'rm_project_cost', env.tenantA), kpis: await Promise.all(bi.CODES.slice(0, 3).map(async (c) => { const k = await read(c); return [c, k.value, k.revisionNo, k.calcHash]; })) });
  const { before } = await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(env.tenantA, event), readRow: snapshot });
  assert.equal(before.kpis.length, 3);
  const again = await bi.kpis(env.tenantA);
  assert.equal(again.written, 0, 'calcular de novo sobre o mesmo estado não grava revisão');
  assert.deepEqual(await Promise.all(bi.CODES.slice(0, 3).map(async (c) => { const k = await read(c); return [c, k.value, k.revisionNo, k.calcHash]; })), before.kpis);
});
