'use strict';

// M9-D643 — painel Locação (rental) pela rota real: widgets na ordem, faixa de qualidade primeiro, rótulos de natureza, valores iguais aos do endpoint de métrica, formato pt-BR, "Dado incompleto"
// em cada grupo de indicadores, alertas, detalhe só com permissão e recusas. Os snapshots vêm dos casos de teste das fórmulas. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envRent = require('../_helpers/painelLocEnv');
const { RENTAL_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { RENT_USER, openPanel, getMetric, seedMetric, cleanup, publishAll } = envRent;
const CODES = RENTAL_PANEL.widgets.filter((w) => w.metricCode).map((w) => w.metricCode);
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const metricWidgets = (res) => res.body.data.widgets.filter((w) => w.metric);
const by = (res, c) => metricWidgets(res).find((w) => w.metricCode === c);
const GROUPS = {
  carteira: ['rent.active_contracts', 'rent.vacancy', 'rent.delinquency'],
  prazos: ['rent.guarantees_expiring', 'rent.obligations_pending', 'rent.inspections_keys'],
  atendimento: ['rent.tickets', 'rent.satisfaction', 'rent.repasses'],
};
let env;
/** Apaga e regrava os snapshots dos 9 indicadores (o snapshot da data-base não se sobrescreve). */
const reseed = async (opts = {}) => {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  for (const c of CODES) await seedMetric(env.tenantA, c, { degraded: (opts.degraded || []).includes(c), result: (opts.results || {})[c] });
};

before(async () => { env = await envRent.setup(); await reseed(); });
after(() => envRent.teardown(env));

test('m9d643 painel devolve widgets na ordem definida', async () => {
  const res = await openPanel(env, 'rental', { perms: RENT_USER });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.dashboardCode, 'rental');
  assert.deepEqual(res.body.data.widgets.map((w) => [w.position, w.type, w.metricCode]), RENTAL_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
  assert.deepEqual(metricWidgets(res).map((w) => w.metricCode), [
    'rent.active_contracts', 'rent.vacancy', 'rent.delinquency', 'rent.guarantees_expiring', 'rent.obligations_pending', 'rent.inspections_keys', 'rent.tickets', 'rent.satisfaction', 'rent.repasses',
  ], 'os oito blocos do livro: três cartões da carteira, garantias, obrigações, vistorias e chaves, chamados, satisfação e repasses');
});

test('m9d643 faixa de qualidade vem antes dos números', async () => {
  const res = await openPanel(env, 'rental', { perms: RENT_USER });
  const first = res.body.data.widgets[0];
  assert.deepEqual([first.type, first.position, first.banner.visible, first.banner.degradedMetrics], ['QUALITY_BANNER', 0, false, []], 'dados frescos: sem aviso');
  const old = await openPanel(env, 'rental', { perms: RENT_USER, query: 'asOf=2026-10-20' });
  assert.equal(old.body.data.widgets[0].type, 'QUALITY_BANNER');
  assert.deepEqual(old.body.data.widgets[0].banner.degradedMetrics.map((d) => d.metricCode).sort(), [...CODES].sort(), 'os 9 indicadores sem registro na data-base aparecem na faixa');
});

test('m9d643 rótulos de natureza presentes', async () => {
  for (const w of metricWidgets(await openPanel(env, 'rental', { perms: RENT_USER }))) {
    assert.ok(['Realizado', 'Previsto', 'Estimado', 'Projetado'].includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
    assert.equal(w.metric.freshness.state, 'FRESH', w.metricCode);
  }
});

test('m9d643 valores do painel iguais aos do endpoint de métrica (a tela só desenha o que a API devolveu)', async () => {
  const widgets = metricWidgets(await openPanel(env, 'rental', { perms: RENT_USER }));
  assert.equal(widgets.length, 9);
  for (const w of widgets) {
    const direct = await getMetric(env, w.metricCode, RENT_USER);
    assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
    const d = direct.body.data;
    assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature, w.metric.formatted], [d.value, d.status, d.version, d.unit, d.valueNature, d.formatted], w.metricCode);
  }
});

test('m9d643 cartões em pt-BR: contratos por faixa de valor, vacância, inadimplência por faixa de atraso e satisfação por papel', async () => {
  await reseed();
  const res = await openPanel(env, 'rental', { perms: RENT_USER });
  const active = by(res, 'rent.active_contracts');
  assert.deepEqual(active.view.facts.map((f) => [f.label, f.formatted]), [['Aluguel mensal vigente', 'R$ 2.500,00'], ['Suspensos', '0']]);
  assert.deepEqual(active.view.items.map((i) => i.id), ['ate_2000', '2001-5000', '5001-10000', 'acima_10000'], 'faixas de valor da menor para a maior, "até" primeiro e "acima de" por último');
  assert.equal(by(res, 'rent.vacancy').metric.formatted, '6,59%');
  assert.deepEqual(by(res, 'rent.vacancy').view.facts.map((f) => f.formatted), ['91', '85', '6', '0']);
  const delinquency = by(res, 'rent.delinquency');
  assert.deepEqual([delinquency.metric.formatted, delinquency.view.items.map((i) => [i.id, i.formatted])], ['10,00%', [['1-30', '10,00%'], ['31-60', '0,00%'], ['61-90', '0,00%'], ['90+', '0,00%']]]);
  assert.deepEqual(delinquency.view.facts.map((f) => f.formatted), ['R$ 10,00', 'R$ 100,00', 'R$ 0,00']);
  const csat = by(res, 'rent.satisfaction');
  assert.deepEqual(csat.view.items.map((i) => [i.id, i.formatted]), [['INQUILINO', '3,67'], ['PROPRIETARIO', '4,00']].sort((a, b) => Number(b[1].replace(',', '.')) - Number(a[1].replace(',', '.'))));
});

test('m9d643 garantias, obrigações, vistorias e chaves, chamados e repasses mostram os números prontos', async () => {
  const res = await openPanel(env, 'rental', { perms: RENT_USER });
  const guarantees = by(res, 'rent.guarantees_expiring');
  assert.deepEqual(guarantees.view.facts.map((f) => [f.label, f.formatted]), [['Vencem em até 30 dias', '4'], ['Vencem em até 60 dias', '7'], ['Vencidas', '1']]);
  assert.deepEqual(guarantees.view.items.map((i) => [i.id, i.formatted]), [['INSURANCE', '3'], ['GUARANTOR', '1']], 'por tipo de garantia, a lista que o detalhe abre');
  assert.deepEqual(by(res, 'rent.obligations_pending').view.facts.map((f) => f.formatted), ['5', '18', '12 dias']);
  const keys = by(res, 'rent.inspections_keys');
  assert.equal(keys.view.noTotal, true, 'card duplo: vistorias e chaves lado a lado, sem total');
  assert.deepEqual(keys.view.series.map((s) => [s.label, s.formatted]), [['Vistorias pendentes', '0'], ['Vistorias atrasadas', '0'], ['Chaves fora', '0'], ['Chaves atrasadas', '0']]);
  assert.deepEqual(by(res, 'rent.tickets').view.facts.map((f) => [f.label, f.formatted]), [['Tempo médio de resolução', '12,5 h'], ['Abertos no mês', '1'], ['Fechados no mês', '1']]);
  assert.deepEqual(by(res, 'rent.repasses').view.facts.map((f) => f.formatted), ['R$ 1.000,00', 'R$ 0,00', 'R$ 0,00', '100,00%']);
});

test('m9d643 repasse atrasado acende o alerta do cartão; sem atraso, não', async () => {
  const repasses = (late) => ({ value: '2', status: 'OK', dimensions: [{ key: 'pagos_brl', value: '1000.00' }, { key: 'atrasados_brl', value: late }, { key: 'no_prazo_pct', value: '50.00' }] });
  await reseed({ results: { 'rent.repasses': repasses('800.00') } });
  assert.equal(by(await openPanel(env, 'rental', { perms: RENT_USER }), 'rent.repasses').view.alert, true);
  await reseed({ results: { 'rent.repasses': repasses('0.00') } });
  assert.equal(by(await openPanel(env, 'rental', { perms: RENT_USER }), 'rent.repasses').view.alert, false);
  await reseed();
});

test('m9d643 KPI de Locação DEGRADED ou INCOMPLETE mostra Dado incompleto e nunca um número, em cada grupo', async () => {
  for (const [group, list] of Object.entries(GROUPS)) {
    await reseed({ degraded: list });
    const res = await openPanel(env, 'rental', { perms: RENT_USER });
    for (const w of metricWidgets(res)) {
      if (!list.includes(w.metricCode)) { assert.equal(w.metric.incomplete, false, `${group}: ${w.metricCode} segue com número`); continue; }
      assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], `${group}: ${w.metricCode}`);
      assert.ok((w.view.series || []).every((s) => s.value === null && s.formatted === null), `${w.metricCode}: nenhuma série com número`);
      assert.deepEqual([w.view.items || [], w.view.facts || []], [[], []], `${w.metricCode}: nenhuma linha nem fato com número`);
    }
    assert.deepEqual(res.body.data.widgets[0].banner.degradedMetrics.map((d) => d.metricCode).sort(), [...list].sort(), `${group}: a faixa antes dos cartões lista os degradados`);
  }
  await reseed();
});

test('m9d643 Ver detalhe: só o indicador crítico com origem, com analytics:drilldown e legal:read; sem a permissão do detalhe vem o agregado', async () => {
  const withPerm = await openPanel(env, 'rental', { perms: [...RENT_USER, 'analytics:drilldown'] });
  const guarantees = by(withPerm, 'rent.guarantees_expiring');
  assert.deepEqual([guarantees.drilldown.enabled, guarantees.drilldown.allowed], [true, true], 'garantias a vencer é crítico e tem origem');
  assert.ok(guarantees.drilldown.sourceRef.table, 'o item de sourceRefs do número vai ao detalhe');
  for (const w of metricWidgets(withPerm).filter((x) => x.metricCode !== 'rent.guarantees_expiring')) assert.equal(w.drilldown.allowed, false, `${w.metricCode}: sem origem gravada ou não crítico, sem botão`);
  const without = await openPanel(env, 'rental', { perms: RENT_USER });
  assert.ok(metricWidgets(without).every((w) => w.drilldown.allowed === false), 'sem analytics:drilldown nenhum botão');
  assert.equal(by(without, 'rent.guarantees_expiring').drilldown.enabled, true, 'o detalhe existe, só não é liberado');
  const ref = guarantees.drilldown.sourceRef;
  const query = `filter=${encodeURIComponent(JSON.stringify(ref.filter))}&filterHash=${ref.filterHash}&filterSignature=${ref.filterSignature}&page=1&pageSize=20`;
  const open = await env.call('GET', `/analytics/metrics/rent.guarantees_expiring/drilldown?${query}`, { perms: [...RENT_USER, 'analytics:drilldown'] });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const denied = await env.call('GET', `/analytics/metrics/rent.guarantees_expiring/drilldown?${query}`, { perms: RENT_USER });
  assert.deepEqual([denied.status, denied.body.code || denied.body.error.code], [403, 'ANALYTICS_DRILLDOWN_FORBIDDEN']);
  assert.ok(JSON.stringify(denied.body).includes('aggregate'), 'a recusa traz o agregado permitido');
});

test('m9d643 painel sem permissão devolve 403', async () => {
  assert.equal((await openPanel(env, 'rental', { perms: [] })).status, 403);
  const only = await openPanel(env, 'rental', { perms: ['analytics:read'] });
  assert.deepEqual([only.status, code(only)], [403, 'PERMISSION_DENIED']);
  assert.match(only.body.error.message, /legal:read/);
  assert.equal((await openPanel(env, 'rental', { perms: ['legal:read'] })).status, 403, 'sem analytics:read nenhum painel abre');
  const missing = await openPanel(env, 'locacao', { perms: RENT_USER });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openPanel(env, 'rental', { perms: RENT_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
});
