'use strict';

// M9-D654 — painéis Obras (construction), Estoque/Patrimônio (inventory) e Pós-obra (postwork) pela rota real: widgets na ordem do livro, faixa de qualidade
// primeiro, rótulos de natureza, valores iguais aos do endpoint de métrica, "Dado incompleto" nos KPIs degradados, séries separadas sem total
// (linha de base/realizado/projetada e realizado/previsto do pós-obra), linhas por obra, ranking de recorrência, detalhe só com permissão e recusas.
// Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env654 = require('../_helpers/painelObrasEnv');
const { CONSTRUCTION_PANEL, INVENTORY_PANEL, POSTWORK_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { OBRA_USER, INV_USER, openPanel, getMetric, seedMetric, seedPanel, reset } = env654;
const ORDER = {
  construction: ['obra.progress_vs_schedule', 'obra.delays', 'obra.baseline_actual_forecast', 'obra.projected_margin', 'obra.measurements', 'obra.nonconformities', 'obra.waste'],
  inventory: ['inv.stock_value', 'inv.below_minimum', 'inv.losses', 'inv.tools_overdue'],
  postwork: ['obra.postwork_cost', 'obra.recurrence'],
};
const PANELS = [['construction', CONSTRUCTION_PANEL, OBRA_USER], ['inventory', INVENTORY_PANEL, INV_USER], ['postwork', POSTWORK_PANEL, OBRA_USER]];
const ALL = PANELS.map(([, panel]) => panel);
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const metricWidgets = (res) => res.body.data.widgets.filter((w) => w.metric);
const by = (res, c) => metricWidgets(res).find((w) => w.metricCode === c);
const fresh = async (opts) => { await env654.cleanup(env, env.tenantA); await env654.publishAll(env.tenantA); return opts; };
let env;
let seeded;

before(async () => {
  env = await env654.setup();
  seeded = await reset(env, ALL);
});
after(() => env654.teardown(env));

test('m9d654 painel devolve widgets na ordem definida', async () => {
  for (const [name, panel, perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.dashboardCode, name);
    assert.deepEqual(res.body.data.widgets.map((w) => [w.position, w.type, w.metricCode]), panel.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]), name);
    assert.deepEqual(res.body.data.widgets.map((w) => w.metricCode).filter(Boolean), ORDER[name], `${name}: exatamente os widgets do livro, na ordem`);
  }
  assert.deepEqual(metricWidgets(await openPanel(env, 'construction', { perms: OBRA_USER })).map((w) => w.type), ['BAR', 'KPI_CARD', 'KPI_CARD', 'KPI_CARD', 'KPI_CARD', 'KPI_CARD', 'TABLE']);
});

test('m9d654 faixa de qualidade vem antes dos números', async () => {
  for (const [name, , perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    const first = res.body.data.widgets[0];
    assert.deepEqual([first.type, first.position, first.banner.visible, first.banner.degradedMetrics], ['QUALITY_BANNER', 0, false, []], `${name}: dados fresh, sem aviso`);
    const old = await openPanel(env, name, { perms, query: 'asOf=2026-10-20' });
    assert.equal(old.body.data.widgets[0].type, 'QUALITY_BANNER');
    assert.equal(old.body.data.widgets[0].banner.degradedMetrics.length, ORDER[name].length, `${name}: os KPIs sem registro na data-base aparecem na faixa`);
  }
});

test('m9d654 rótulos de natureza presentes', async () => {
  for (const [name, , perms] of PANELS) {
    for (const w of metricWidgets(await openPanel(env, name, { perms }))) {
      assert.ok(['Realizado', 'Previsto', 'Estimado', 'Projetado'].includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
      assert.equal(w.metric.freshness.state, 'FRESH', w.metricCode);
      assert.ok(w.metric.version >= 1, `${w.metricCode}: versão da métrica para o tooltip`);
    }
  }
  const construction = await openPanel(env, 'construction', { perms: OBRA_USER });
  assert.equal(by(construction, 'obra.baseline_actual_forecast').metric.valueNatureLabel, 'Projetado');
  assert.equal(by(construction, 'obra.projected_margin').metric.valueNatureLabel, 'Projetado');
  assert.equal(by(construction, 'obra.delays').metric.valueNatureLabel, 'Realizado');
});

test('m9d654 valores da tela iguais aos do endpoint de métrica', async () => {
  for (const [name, , perms] of PANELS) {
    const widgets = metricWidgets(await openPanel(env, name, { perms }));
    assert.equal(widgets.length, ORDER[name].length, `${name}: todos os indicadores do painel`);
    for (const w of widgets) {
      const direct = await getMetric(env, w.metricCode, perms);
      assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
      const d = direct.body.data;
      assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature], [d.value, d.status, d.version, d.unit, d.valueNature], w.metricCode);
      assert.equal(Number(w.metric.value), Number(seeded[w.metricCode].result.value), `${w.metricCode}: igual ao resultado gravado`);
      assert.ok(w.metric.formatted, `${w.metricCode}: valor pronto em pt-BR`);
    }
  }
});

test('m9d654 KPI de obras, estoque e pós-obra DEGRADED mostra Dado incompleto no lugar do número', async () => {
  for (const [name, panel, perms] of PANELS) {
    await fresh();
    await seedPanel(env.tenantA, panel, { degraded: ORDER[name] });
    const res = await openPanel(env, name, { perms });
    const widgets = metricWidgets(res);
    assert.equal(widgets.length, ORDER[name].length);
    for (const w of widgets) {
      assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], w.metricCode);
      assert.ok((w.view.series || []).every((s) => s.value === null && s.formatted === null), `${w.metricCode}: nenhuma série com número`);
      assert.deepEqual(w.view.items || [], [], w.metricCode);
    }
    const banner = res.body.data.widgets[0].banner;
    assert.deepEqual([banner.visible, banner.degradedMetrics.length], [true, ORDER[name].length], `${name}: faixa antes dos cartões`);
  }
  await fresh();
  await seedPanel(env.tenantA, CONSTRUCTION_PANEL, { skip: ['obra.delays', 'obra.waste'] });
  const partial = await openPanel(env, 'construction', { perms: OBRA_USER });
  for (const c of ['obra.delays', 'obra.waste']) {
    const w = by(partial, c);
    assert.deepEqual([w.metric.status, w.metric.incomplete, w.metric.value, w.metric.incompleteText], ['INCOMPLETE', true, null, 'Dado incompleto'], c);
  }
  assert.equal(partial.body.data.widgets[0].banner.degradedMetrics.length, 2);
  seeded = await reset(env, ALL);
});

test('m9d654 empresa com 3 obras: 3 linhas com progresso, atraso e margem projetada', async () => {
  const pct = (id, real) => [{ key: `obra:${id}:realizado_pct`, value: real }, { key: `obra:${id}:planejado_pct`, value: '50.00' }, { key: `obra:${id}:desvio_pp`, value: (Number(real) - 50).toFixed(2) }];
  await fresh();
  await seedMetric(env.tenantA, 'obra.progress_vs_schedule', { result: { value: '40.00', status: 'OK', dimensions: [{ key: 'planejado_pct', value: '50.00' }, { key: 'desvio_pp', value: '-10.00' }, ...pct('o1', '60.00'), ...pct('o2', '40.00'), ...pct('o3', '20.00')] } });
  await seedMetric(env.tenantA, 'obra.delays', { result: { value: '4', status: 'OK', dimensions: [{ key: 'maximo_dias', value: '12' }, { key: 'obra:o1', value: '1' }, { key: 'obra:o2', value: '3' }, { key: 'obra:o3', value: '0' }] } });
  await seedMetric(env.tenantA, 'obra.projected_margin', { result: { value: '90000.00', status: 'OK', dimensions: [{ key: 'margem_pct', value: '18.00' }, { key: 'obra:o1', value: '50000.00' }, { key: 'obra:o1:margem_pct', value: '25.00' }, { key: 'obra:o2', value: '30000.00' }, { key: 'obra:o3', value: '10000.00' }] } });
  const res = await openPanel(env, 'construction', { perms: OBRA_USER });
  const progress = by(res, 'obra.progress_vs_schedule');
  assert.deepEqual(progress.view.items.map((i) => [i.id, i.formatted]), [['o1', '60,00%'], ['o2', '40,00%'], ['o3', '20,00%']], 'uma barra por obra, do maior avanço ao menor');
  assert.deepEqual(progress.view.items[2].extra.map((x) => [x.label, x.formatted]), [['Planejado', '50,00%'], ['Desvio', '-30 p.p.']]);
  assert.deepEqual(by(res, 'obra.delays').view.items.map((i) => i.id), ['o2', 'o1', 'o3']);
  assert.equal(by(res, 'obra.delays').view.alert, true, 'há atraso: o cartão acende o alerta');
  const margin = by(res, 'obra.projected_margin');
  assert.deepEqual(margin.view.items.map((i) => [i.id, i.formatted]), [['o1', 'R$ 50.000,00'], ['o2', 'R$ 30.000,00'], ['o3', 'R$ 10.000,00']]);
  assert.equal(margin.view.facts.find((f) => f.key === 'margem_pct').formatted, '18,00%');
  seeded = await reset(env, ALL);
});

test('m9d654 linha de base, realizado e projetada em três séries separadas, sem total', async () => {
  const dims = [{ key: 'baseline_brl', value: '1000000.00' }, { key: 'actual_brl', value: '420000.00' }, { key: 'forecast_brl', value: '1150000.00' }];
  await fresh();
  await seedMetric(env.tenantA, 'obra.baseline_actual_forecast', { result: { value: '1150000.00', status: 'OK', dimensions: dims } });
  const w = by(await openPanel(env, 'construction', { perms: OBRA_USER }), 'obra.baseline_actual_forecast');
  assert.deepEqual(w.view.series.map((s) => [s.label, s.valueNature, s.valueNatureLabel, s.formatted]), [
    ['Linha de base', 'PLANNED', 'Previsto', 'R$ 1.000.000,00'], ['Realizado', 'ACTUAL', 'Realizado', 'R$ 420.000,00'], ['Projetada', 'PROJECTED', 'Projetado', 'R$ 1.150.000,00'],
  ]);
  assert.equal(w.view.noTotal, true, 'três naturezas nunca se somam');
  assert.ok(!('total' in w.view) && !w.view.series.some((s) => /total/i.test(s.label)));
  seeded = await reset(env, ALL);
});

test('m9d654 pós-obra mostra o previsto à parte do realizado e o ranking de recorrência', async () => {
  const cost = { value: '38500.00', status: 'OK', dimensions: [{ key: 'obra:p1', value: '38500.00' }, { key: 'obra:p1:custo_pct', value: '3.21' }, { key: 'causa:UMIDADE', value: '38500.00' }, { key: 'previsto_brl', value: '4000.00' }, { key: 'receita_brl', value: '1200000.00' }, { key: 'custo_pct', value: '3.21' }] };
  const rec = {
    value: '2', status: 'OK',
    dimensions: [{ key: 'causa:A', value: '7' }, { key: 'causa:A:obras_qtd', value: '4' }, { key: 'causa:A:custo_brl', value: '700.00' }, { key: 'causa:B', value: '9' }, { key: 'causa:B:obras_qtd', value: '5' }, { key: 'causa:B:custo_brl', value: '900.00' }, { key: 'equipe:X', value: '3' }, { key: 'equipe:X:obras_qtd', value: '2' }, { key: 'equipe:X:custo_brl', value: '300.00' }],
  };
  await fresh();
  await seedMetric(env.tenantA, 'obra.postwork_cost', { result: cost });
  await seedMetric(env.tenantA, 'obra.recurrence', { result: rec });
  const res = await openPanel(env, 'postwork', { perms: OBRA_USER });
  const w = by(res, 'obra.postwork_cost');
  assert.deepEqual(w.view.series.map((s) => [s.label, s.valueNatureLabel, s.formatted]), [['Realizado', 'Realizado', 'R$ 38.500,00'], ['Previsto', 'Previsto', 'R$ 4.000,00']]);
  assert.equal(w.view.noTotal, true, 'o previsto não soma ao realizado');
  assert.equal(w.view.facts.find((f) => f.key === 'custo_pct').formatted, '3,21%');
  const ranking = by(res, 'obra.recurrence');
  assert.deepEqual(ranking.view.items.map((i) => i.id), ['causa:B', 'causa:A', 'equipe:X'], 'ranking: cada tipo de causa em ordem decrescente');
  assert.deepEqual(ranking.view.items[0].cells.map((c) => [c.label, c.formatted]), [['Ocorrências', '9'], ['Obras', '5'], ['Custo', 'R$ 900,00']]);
  assert.equal(ranking.view.items[0].groupLabel, 'Causa');
  assert.deepEqual(ranking.view.columns.map((c) => c.label), ['Ocorrências', 'Obras', 'Custo']);
  seeded = await reset(env, ALL);
});

test('m9d654 painel de estoque entrega os fatos prontos de cada indicador', async () => {
  const res = await openPanel(env, 'inventory', { perms: INV_USER });
  const facts = (c) => Object.fromEntries(by(res, c).view.facts.map((f) => [f.key, f.formatted]));
  assert.deepEqual(Object.keys(facts('inv.stock_value')), ['sem_custo_qtd']);
  assert.deepEqual(Object.keys(facts('inv.below_minimum')), ['rupturas_qtd', 'sem_minimo_qtd']);
  assert.deepEqual(Object.keys(facts('inv.losses')), ['casos_qtd', 'abertos_qtd', 'sem_valor_qtd']);
  assert.deepEqual(Object.keys(facts('inv.tools_overdue')), ['abertos_qtd', 'manutencao_qtd', 'sem_data_qtd']);
});

test('m9d654 detalhe só com permissão: KPI crítico libera o botão, o normal não', async () => {
  const withDetail = await openPanel(env, 'construction', { perms: [...OBRA_USER, 'analytics:drilldown'] });
  for (const c of ['obra.delays', 'obra.baseline_actual_forecast', 'obra.projected_margin', 'obra.measurements', 'obra.waste']) {
    const d = by(withDetail, c).drilldown;
    assert.deepEqual([c, d.enabled, d.allowed], [c, true, true]);
    assert.ok(d.sourceRef.filterHash, c);
  }
  for (const c of ['obra.progress_vs_schedule', 'obra.nonconformities']) assert.deepEqual([c, by(withDetail, c).drilldown.enabled], [c, false], 'indicador normal não tem detalhe de BI');
  const plain = by(await openPanel(env, 'construction', { perms: OBRA_USER }), 'obra.delays');
  assert.deepEqual([plain.drilldown.enabled, plain.drilldown.allowed], [true, false], 'sem analytics:drilldown só o agregado');
  const ref = by(withDetail, 'obra.delays').drilldown.sourceRef;
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature }).toString();
  const refused = await env.call('GET', `/analytics/metrics/obra.delays/drilldown?${q}`, { perms: OBRA_USER });
  assert.equal(refused.status, 403);
  assert.equal(code(refused), 'ANALYTICS_DRILLDOWN_FORBIDDEN');
  assert.ok(refused.body.error.details.aggregate !== undefined, 'o 403 traz o agregado');
  const inv = await openPanel(env, 'inventory', { perms: [...INV_USER, 'analytics:drilldown'] });
  assert.deepEqual([by(inv, 'inv.losses').drilldown.enabled, by(inv, 'inv.losses').drilldown.allowed], [true, true]);
  assert.equal(by(inv, 'inv.stock_value').drilldown.enabled, false);
  const post = await openPanel(env, 'postwork', { perms: [...OBRA_USER, 'analytics:drilldown'] });
  assert.deepEqual([by(post, 'obra.postwork_cost').drilldown.enabled, by(post, 'obra.postwork_cost').drilldown.allowed], [true, true]);
  assert.equal(by(post, 'obra.recurrence').drilldown.enabled, false);
});

test('m9d654 painel sem permissão devolve 403', async () => {
  for (const [name] of PANELS) assert.equal((await openPanel(env, name, { perms: [] })).status, 403, name);
  const onlyBi = await openPanel(env, 'construction', { perms: ['analytics:read'] });
  assert.deepEqual([onlyBi.status, code(onlyBi)], [403, 'PERMISSION_DENIED']);
  assert.match(onlyBi.body.error.message, /construction:read/);
  assert.match((await openPanel(env, 'inventory', { perms: ['analytics:read'] })).body.error.message, /inventory:read/);
  assert.match((await openPanel(env, 'postwork', { perms: ['analytics:read'] })).body.error.message, /construction:read/);
  const noBi = await openPanel(env, 'construction', { perms: ['construction:read'] });
  assert.deepEqual([noBi.status, code(noBi)], [403, 'PERMISSION_DENIED']);
  assert.match(noBi.body.error.message, /analytics:read/);
  assert.equal((await openPanel(env, 'inventory', { perms: OBRA_USER })).status, 403, 'construction:read não abre o painel de Estoque');
  assert.equal((await openPanel(env, 'construction', { perms: INV_USER })).status, 403, 'inventory:read não abre o painel de Obras');
  assert.equal((await openPanel(env, 'postwork', { perms: INV_USER })).status, 403, 'inventory:read não abre o painel de Pós-obra');
  const missing = await openPanel(env, 'obras', { perms: OBRA_USER });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openPanel(env, 'construction', { perms: OBRA_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
});
