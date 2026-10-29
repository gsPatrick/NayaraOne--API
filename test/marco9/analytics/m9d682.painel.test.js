'use strict';

// M9-D682 — painel Segurança/Integrações/IA (tech) pela rota real: widgets na ordem do livro, faixa de qualidade primeiro, rótulos de natureza, valores iguais aos do endpoint de métrica,
// "Dado incompleto" nos KPIs degradados e "Dado desatualizado" com o valor da última medição na fila, detalhe só com permissão e recusas. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env682 = require('../_helpers/painelTechEnv');
const { TECH_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { TECH_USER, openPanel, getMetric, seedPanel, seedMetric, cleanup, publishAll } = env682;
const ORDER = ['tec.availability', 'tec.freshness', 'tec.queues_dlq', 'tec.integration_errors', 'tec.auth_failures', 'tec.blocked_events', 'ai.cost_by_agent', 'ai.budget', 'ai.quality_scores', 'ai.tool_calls_blocked'];
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const metricWidgets = (res) => res.body.data.widgets.filter((w) => w.metric);
const by = (res, c) => metricWidgets(res).find((w) => w.metricCode === c);
let env;
let seeded;
const reseed = async (opts) => { await cleanup(env, env.tenantA); await publishAll(env.tenantA); return seedPanel(env.tenantA, TECH_PANEL, opts); };

before(async () => {
  env = await env682.setup();
  seeded = await seedPanel(env.tenantA, TECH_PANEL);
});
after(() => env682.teardown(env));

test('m9d682 painel devolve widgets na ordem definida', async () => {
  const res = await openPanel(env, 'tech', { perms: TECH_USER });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.dashboardCode, 'tech');
  assert.deepEqual(res.body.data.widgets.map((w) => [w.position, w.type, w.metricCode]), TECH_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
  assert.deepEqual(res.body.data.widgets.map((w) => w.metricCode).filter(Boolean), ORDER, 'exatamente os widgets do livro, na ordem: 2, 3, 4, 5, 6 e 7 da seção 3.2');
  assert.equal(res.body.data.widgets.length, 11, 'a faixa de qualidade e os 10 indicadores');
});

test('m9d682 faixa de qualidade vem antes dos números', async () => {
  const res = await openPanel(env, 'tech', { perms: TECH_USER });
  const first = res.body.data.widgets[0];
  assert.deepEqual([first.type, first.position, first.banner.visible, first.banner.degradedMetrics], ['QUALITY_BANNER', 0, false, []], 'dados fresh, sem aviso');
  const old = await openPanel(env, 'tech', { perms: TECH_USER, query: 'asOf=2026-10-20' });
  assert.equal(old.body.data.widgets[0].type, 'QUALITY_BANNER');
  assert.equal(old.body.data.widgets[0].banner.degradedMetrics.length, 10, 'os dez KPIs sem registro na data-base aparecem na faixa');
});

test('m9d682 rótulos de natureza presentes', async () => {
  for (const w of metricWidgets(await openPanel(env, 'tech', { perms: TECH_USER }))) {
    assert.ok(['Realizado', 'Previsto', 'Estimado', 'Projetado'].includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
    assert.equal(w.metric.freshness.state, 'FRESH', w.metricCode);
    assert.ok(w.metric.version === 1 && w.metric.metricCode === w.metricCode, `${w.metricCode}: versão da métrica para o tooltip`);
  }
});

test('m9d682 valores da tela iguais aos do endpoint de métrica', async () => {
  const widgets = metricWidgets(await openPanel(env, 'tech', { perms: TECH_USER }));
  assert.equal(widgets.length, 10);
  for (const w of widgets) {
    const direct = await getMetric(env, w.metricCode, TECH_USER);
    assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
    const d = direct.body.data;
    assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature], [d.value, d.status, d.version, d.unit, d.valueNature], w.metricCode);
    assert.equal(Number(w.metric.value), Number(seeded[w.metricCode].result.value), `${w.metricCode}: igual ao resultado gravado`);
  }
});

test('m9d682 cada indicador desenha as linhas e os fatos que a API entregou, sem cálculo', async () => {
  const res = await openPanel(env, 'tech', { perms: TECH_USER });
  const avail = by(res, 'tec.availability');
  assert.deepEqual(avail.view.columns.map((c) => c.label), ['Disponibilidade', 'Sondas ausentes']);
  assert.ok(avail.view.items.length >= 1 && avail.view.items.every((r) => r.cells.every((c) => c.formatted !== null)));
  assert.match(avail.view.facts[0].formatted, / min$/, 'minutos fora do ar com a unidade');
  const queues = by(res, 'tec.queues_dlq');
  assert.match(queues.view.facts.find((f) => f.key === 'mais_antigo_s').formatted, / s$/, 'idade do item mais antigo em segundos');
  const cost = by(res, 'ai.cost_by_agent');
  assert.match(cost.metric.formatted, /^R\$ /);
  const budget = by(res, 'ai.budget');
  assert.match(budget.view.items[0].cells.map((c) => c.formatted).join('|'), /%/, 'consumo em percentual');
  const quality = by(res, 'ai.quality_scores');
  assert.ok(quality.view.facts.some((f) => f.key === 'avaliacao_nota'), 'a nota de avaliação vem pronta');
});

test('m9d682 KPI degradado mostra Dado incompleto no lugar do número e a fila desatualizada mostra o valor da última medição', async () => {
  const degraded = ['tec.availability', 'tec.integration_errors', 'tec.auth_failures', 'tec.blocked_events'];
  const stale = { value: '12', status: 'STALE', dimensions: [{ key: 'dlq_qtd', value: '3' }, { key: 'mais_antigo_s', value: '40' }, { key: 'fila:outbox:profundidade_qtd', value: '12' }] };
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  await seedPanel(env.tenantA, TECH_PANEL, { degraded, skip: ['tec.queues_dlq'] });
  await seedMetric(env.tenantA, 'tec.queues_dlq', { result: stale });
  const res = await openPanel(env, 'tech', { perms: TECH_USER });
  for (const c of degraded) {
    const w = by(res, c);
    assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], c);
    assert.deepEqual(w.view.items || [], [], `${c}: nenhuma linha com número enganoso`);
    assert.deepEqual(w.view.facts || [], [], `${c}: nenhum fato`);
  }
  const queue = by(res, 'tec.queues_dlq');
  assert.deepEqual([queue.metric.incomplete, queue.metric.value, queue.metric.formatted, queue.metric.staleText, queue.metric.status], [false, '12.0000', '12', 'Dado desatualizado', 'STALE'], 'o valor da última medição continua à vista, com o aviso');
  assert.equal(queue.view.facts.find((f) => f.key === 'mais_antigo_s').formatted, '40 s');
  assert.equal(res.body.data.widgets[0].banner.degradedMetrics.length >= 4, true, 'a faixa vem antes e lista os degradados');
  assert.equal(res.body.data.widgets[0].position, 0);
  seeded = await reseed();
});

test('m9d682 os KPIs de IA degradados ou incompletos mostram Dado incompleto', async () => {
  const bad = ['ai.cost_by_agent', 'ai.quality_scores', 'ai.budget', 'ai.tool_calls_blocked'];
  await reseed({ degraded: bad });
  const res = await openPanel(env, 'tech', { perms: TECH_USER });
  for (const c of bad) {
    const w = by(res, c);
    assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.incompleteText, w.view.items], [true, null, 'Dado incompleto', []], c);
  }
  assert.equal(res.body.data.widgets[0].banner.degradedMetrics.length, 4);
  seeded = await reseed();
});

test('m9d682 detalhe só com permissão: o KPI crítico libera o botão, os normais não', async () => {
  const withDetail = await openPanel(env, 'tech', { perms: [...TECH_USER, 'analytics:drilldown'] });
  const critical = by(withDetail, 'tec.integration_errors');
  assert.deepEqual([critical.drilldown.enabled, critical.drilldown.allowed], [true, true]);
  assert.ok(critical.drilldown.sourceRef.filterHash);
  for (const c of ORDER.filter((x) => x !== 'tec.integration_errors')) assert.deepEqual([by(withDetail, c).drilldown.enabled, by(withDetail, c).drilldown.allowed], [false, false], `${c} é NORMAL: sem botão`);
  const plain = by(await openPanel(env, 'tech', { perms: TECH_USER }), 'tec.integration_errors');
  assert.deepEqual([plain.drilldown.enabled, plain.drilldown.allowed], [true, false], 'sem analytics:drilldown só o agregado');
  const ref = critical.drilldown.sourceRef;
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature }).toString();
  const refused = await env.call('GET', `/analytics/metrics/tec.integration_errors/drilldown?${q}`, { perms: TECH_USER });
  assert.equal(refused.status, 403);
  assert.equal(code(refused), 'ANALYTICS_DRILLDOWN_FORBIDDEN');
  assert.ok(refused.body.error.details.aggregate !== undefined, 'o 403 traz o agregado');
});

test('m9d682 painel sem permissão devolve 403', async () => {
  for (const perms of [[], ['analytics:read']]) {
    const res = await openPanel(env, 'tech', { perms });
    assert.deepEqual([res.status, code(res)], [403, 'PERMISSION_DENIED'], JSON.stringify(perms));
  }
  const noTech = await openPanel(env, 'tech', { perms: ['analytics:read'] });
  assert.match(noTech.body.error.message, /analytics:read:tech/);
  assert.equal((await openPanel(env, 'tech', { perms: ['analytics:read', 'finance:read', 'legal:read'] })).status, 403, 'permissão de outro domínio não abre o painel técnico');
  const missing = await openPanel(env, 'tecnico', { perms: TECH_USER });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openPanel(env, 'tech', { perms: TECH_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
});
