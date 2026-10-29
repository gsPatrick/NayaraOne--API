'use strict';

// M9-D662 — painéis Jurídico (legal) e Correspondente (correspondent) pela rota real: widgets na ordem, faixa de qualidade primeiro, rótulos de natureza,
// valores iguais aos do endpoint de métrica, "Dado incompleto" nos KPIs degradados, séries separadas sem total (valores do processo e comissão), prazos
// com alerta, detalhe só com permissão e recusas por painel. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env662 = require('../_helpers/painelBiEnv');
const { LEGAL_PANEL, CORRESPONDENT_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { LEGAL_USER, COR_USER, openPanel, getMetric, seedPanel, seedMetric, cleanup } = env662;
const PANELS = [['legal', LEGAL_PANEL, LEGAL_USER], ['correspondent', CORRESPONDENT_PANEL, COR_USER]];
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const metricWidgets = (res) => res.body.data.widgets.filter((w) => w.metric);
const by = (res, c) => metricWidgets(res).find((w) => w.metricCode === c);
let env;
let seeded;

before(async () => {
  env = await env662.setup();
  seeded = { ...(await seedPanel(env.tenantA, LEGAL_PANEL)), ...(await seedPanel(env.tenantA, CORRESPONDENT_PANEL)) };
});
after(() => env662.teardown(env));

test('m9d662 painel devolve widgets na ordem definida', async () => {
  for (const [name, panel, perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.dashboardCode, name);
    assert.deepEqual(res.body.data.widgets.map((w) => [w.position, w.type, w.metricCode]), panel.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]), name);
  }
  const legal = await openPanel(env, 'legal', { perms: LEGAL_USER });
  assert.deepEqual(legal.body.data.widgets.map((w) => w.metricCode).filter(Boolean), ['legal.deadlines', 'legal.cases_by_risk', 'legal.values', 'legal.missing_documents']);
  const cor = await openPanel(env, 'correspondent', { perms: COR_USER });
  assert.deepEqual(cor.body.data.widgets.map((w) => w.metricCode).filter(Boolean), ['cor.cases_by_stage', 'cor.approval_rate_by_provider', 'cor.analysis_time', 'cor.commission']);
});

test('m9d662 faixa de qualidade vem antes dos números', async () => {
  for (const [name, , perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    const first = res.body.data.widgets[0];
    assert.deepEqual([first.type, first.position, first.banner.visible, first.banner.degradedMetrics], ['QUALITY_BANNER', 0, false, []], `${name}: dados fresh, sem aviso`);
    const old = await openPanel(env, name, { perms, query: 'asOf=2026-10-20' });
    assert.equal(old.body.data.widgets[0].type, 'QUALITY_BANNER');
    assert.equal(old.body.data.widgets[0].banner.degradedMetrics.length, 4, `${name}: os quatro KPIs sem registro na data-base aparecem na faixa`);
  }
});

test('m9d662 rótulos de natureza presentes', async () => {
  for (const [name, , perms] of PANELS) {
    for (const w of metricWidgets(await openPanel(env, name, { perms }))) {
      assert.ok(['Realizado', 'Previsto', 'Estimado', 'Projetado'].includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
      assert.equal(w.metric.freshness.state, 'FRESH', w.metricCode);
    }
  }
  const values = by(await openPanel(env, 'legal', { perms: LEGAL_USER }), 'legal.values');
  assert.deepEqual(values.view.series.map((s) => [s.label, s.valueNature, s.valueNatureLabel]), [['Estimado', 'ESTIMATED', 'Estimado'], ['Confirmado', 'ACTUAL', 'Realizado']]);
  assert.equal(values.view.noTotal, true, 'estimado e confirmado nunca se somam');
  const commission = by(await openPanel(env, 'correspondent', { perms: COR_USER }), 'cor.commission');
  assert.deepEqual(commission.view.series.map((s) => [s.label, s.valueNature, s.valueNatureLabel]), [['Esperada', 'ESTIMATED', 'Estimado'], ['Confirmada', 'PLANNED', 'Previsto'], ['Recebida', 'ACTUAL', 'Realizado']]);
  assert.equal(commission.view.noTotal, true);
});

test('m9d662 valores da tela iguais aos do endpoint de métrica', async () => {
  for (const [name, , perms] of PANELS) {
    const widgets = metricWidgets(await openPanel(env, name, { perms }));
    assert.equal(widgets.length, 4, `${name}: os quatro indicadores do painel`);
    for (const w of widgets) {
      const direct = await getMetric(env, w.metricCode, perms);
      assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
      const d = direct.body.data;
      assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature], [d.value, d.status, d.version, d.unit, d.valueNature], w.metricCode);
      assert.equal(Number(w.metric.value), Number(seeded[w.metricCode].result.value), `${w.metricCode}: igual ao resultado gravado`);
    }
  }
});

test('m9d662 painel jurídico: 7 prazos em 7 dias e 2 vencidos, com alerta', async () => {
  const dims = (venc) => [{ key: 'proximos_7d_qtd', value: '7' }, { key: 'ate_30d_qtd', value: '3' }, { key: 'vencidos_qtd', value: venc }, { key: 'mais_antigo_vencido_dias', value: '12' }];
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  await seedMetric(env.tenantA, 'legal.deadlines', { result: { value: '12', status: 'OK', dimensions: dims('2') } });
  const w = by(await openPanel(env, 'legal', { perms: LEGAL_USER }), 'legal.deadlines');
  const fact = (k) => w.view.facts.find((f) => f.key === k);
  assert.deepEqual([fact('proximos_7d_qtd').formatted, fact('vencidos_qtd').formatted, fact('ate_30d_qtd').formatted], ['7', '2', '3']);
  assert.equal(fact('mais_antigo_vencido_dias').formatted, '12 dias');
  assert.equal(w.view.alert, true, 'vencidos acendem o alerta do cartão');
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  await seedMetric(env.tenantA, 'legal.deadlines', { result: { value: '10', status: 'OK', dimensions: dims('0').slice(0, 3) } });
  assert.equal(by(await openPanel(env, 'legal', { perms: LEGAL_USER }), 'legal.deadlines').view.alert, false, 'sem vencidos, sem alerta');
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  seeded = { ...(await seedPanel(env.tenantA, LEGAL_PANEL)), ...(await seedPanel(env.tenantA, CORRESPONDENT_PANEL)) };
});

test('m9d662 KPI jurídico e do correspondente DEGRADED mostra Dado incompleto no lugar do número', async () => {
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  await seedPanel(env.tenantA, LEGAL_PANEL, { degraded: ['legal.deadlines', 'legal.cases_by_risk', 'legal.values', 'legal.missing_documents'] });
  await seedPanel(env.tenantA, CORRESPONDENT_PANEL, { degraded: ['cor.cases_by_stage', 'cor.approval_rate_by_provider', 'cor.analysis_time', 'cor.commission'] });
  for (const [name, , perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    const widgets = metricWidgets(res);
    assert.equal(widgets.length, 4);
    for (const w of widgets) {
      assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], w.metricCode);
      assert.ok((w.view.series || []).every((s) => s.value === null && s.formatted === null), `${w.metricCode}: nenhuma série com número`);
      assert.deepEqual(w.view.items || [], [], w.metricCode);
    }
    const banner = res.body.data.widgets[0].banner;
    assert.deepEqual([banner.visible, banner.degradedMetrics.length], [true, 4], `${name}: faixa antes dos cartões`);
  }
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  seeded = { ...(await seedPanel(env.tenantA, LEGAL_PANEL)), ...(await seedPanel(env.tenantA, CORRESPONDENT_PANEL)) };
});

test('m9d662 comissão em três séries separadas, cada uma com o seu valor, sem total', async () => {
  const r = { value: '96000.00', status: 'OK', dimensions: [{ key: 'confirmada_brl', value: '54000.00' }, { key: 'recebida_brl', value: '31000.00' }, { key: 'a_receber_brl', value: '23000.00' }] };
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  await seedMetric(env.tenantA, 'cor.commission', { result: r });
  const w = by(await openPanel(env, 'correspondent', { perms: COR_USER }), 'cor.commission');
  const values = Object.fromEntries(w.view.series.map((s) => [s.label, s.formatted]));
  assert.deepEqual(values, { Esperada: 'R$ 96.000,00', Confirmada: 'R$ 54.000,00', Recebida: 'R$ 31.000,00' });
  assert.equal(w.view.facts.find((f) => f.key === 'a_receber_brl').formatted, 'R$ 23.000,00');
  assert.equal(Object.keys(values).length, 3);
  assert.ok(values.Esperada && values.Confirmada && values.Recebida);
  assert.equal(new Set(Object.values(values)).size, 3, 'três números diferentes, nenhum é a soma dos outros');
  assert.equal(w.view.noTotal, true);
  assert.ok(!('total' in w.view) && !w.view.series.some((s) => /total/i.test(s.label)));
  await cleanup(env, env.tenantA);
  await env662.publishAll(env.tenantA);
  seeded = { ...(await seedPanel(env.tenantA, LEGAL_PANEL)), ...(await seedPanel(env.tenantA, CORRESPONDENT_PANEL)) };
});

test('m9d662 detalhe só com permissão: KPI crítico libera o botão, o normal não', async () => {
  const withDetail = await openPanel(env, 'legal', { perms: [...LEGAL_USER, 'analytics:drilldown'] });
  const deadlines = by(withDetail, 'legal.deadlines');
  assert.deepEqual([deadlines.drilldown.enabled, deadlines.drilldown.allowed], [true, true]);
  assert.ok(deadlines.drilldown.sourceRef.filterHash);
  const normal = by(withDetail, 'legal.values');
  assert.deepEqual([normal.drilldown.enabled, normal.drilldown.allowed], [false, false]);
  const plain = by(await openPanel(env, 'legal', { perms: LEGAL_USER }), 'legal.deadlines');
  assert.deepEqual([plain.drilldown.enabled, plain.drilldown.allowed], [true, false], 'sem analytics:drilldown o jurídico mostra só o agregado');
  const ref = deadlines.drilldown.sourceRef;
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature }).toString();
  const refused = await env.call('GET', `/analytics/metrics/legal.deadlines/drilldown?${q}`, { perms: LEGAL_USER });
  assert.equal(refused.status, 403);
  assert.equal(code(refused), 'ANALYTICS_DRILLDOWN_FORBIDDEN');
  assert.ok(refused.body.error.details.aggregate !== undefined, 'o 403 traz o agregado');
  const cor = by(await openPanel(env, 'correspondent', { perms: [...COR_USER, 'analytics:drilldown'] }), 'cor.commission');
  assert.deepEqual([cor.drilldown.enabled, cor.drilldown.allowed], [true, true]);
});

test('m9d662 painel sem permissão devolve 403', async () => {
  assert.equal((await openPanel(env, 'legal', { perms: [] })).status, 403);
  assert.equal((await openPanel(env, 'correspondent', { perms: [] })).status, 403);
  const legalOnly = await openPanel(env, 'legal', { perms: ['analytics:read'] });
  assert.deepEqual([legalOnly.status, code(legalOnly)], [403, 'PERMISSION_DENIED']);
  assert.match(legalOnly.body.error.message, /legal:read/);
  const corOnly = await openPanel(env, 'correspondent', { perms: ['analytics:read'] });
  assert.equal(corOnly.status, 403);
  assert.match(corOnly.body.error.message, /correspondent:read/);
  assert.equal((await openPanel(env, 'correspondent', { perms: LEGAL_USER })).status, 403, 'legal:read não abre o painel do Correspondente');
  assert.equal((await openPanel(env, 'legal', { perms: COR_USER })).status, 403, 'correspondent:read não abre o painel Jurídico');
  const missing = await openPanel(env, 'juridico', { perms: LEGAL_USER });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openPanel(env, 'legal', { perms: LEGAL_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
});
