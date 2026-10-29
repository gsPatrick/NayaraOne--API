'use strict';

// M9-D634 — painel Vendas/CRM (GET /analytics/dashboards/crm) pela rota real: widgets na ordem do livro, faixa de qualidade primeiro, rótulos de natureza,
// valores iguais aos do endpoint de métrica, cartão "Dado incompleto", ordem do funil pelo parâmetro, detalhe (M9-D690) só com permissão, recusas. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env634 = require('../_helpers/painelBiEnv');
const { CRM_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { AS_OF, CRM_USER, openPanel, getMetric, seedPanel, cleanup } = env634;
const NATURES = ['Realizado', 'Previsto', 'Estimado', 'Projetado'];
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
let env;
let seeded;

before(async () => {
  env = await env634.setup();
  seeded = await seedPanel(env.tenantA, CRM_PANEL);
});
after(() => env634.teardown(env));

const metricWidgets = (res) => res.body.data.widgets.filter((w) => w.metric);

test('m9d634 painel devolve widgets na ordem definida', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.dashboardCode, 'crm');
  assert.deepEqual(data.widgets.map((w) => [w.position, w.type, w.metricCode]), CRM_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
  assert.deepEqual(data.widgets.map((w) => w.metricCode).filter(Boolean), [
    'crm.leads_by_origin', 'crm.first_response_time', 'crm.opportunities_by_stage', 'crm.conversion_rate', 'crm.broker_conversion', 'crm.loss_reasons',
    'crm.portfolio_without_next_action', 'crm.visits', 'crm.proposals', 'prop.active_properties', 'prop.without_sale_by_period', 'prop.price_changes', 'radar.matches', 'crm.broker_capture',
  ]);
  assert.equal(data.widgets.length, 15, 'a faixa de qualidade e os 14 indicadores');
  assert.equal(data.asOfDate, AS_OF);
  assert.ok(data.generatedAt);
});

test('m9d634 faixa de qualidade vem antes dos números', async () => {
  const ok = await openPanel(env, 'crm', { perms: CRM_USER });
  assert.equal(ok.body.data.widgets[0].type, 'QUALITY_BANNER');
  assert.equal(ok.body.data.widgets[0].position, 0);
  assert.deepEqual([ok.body.data.widgets[0].banner.visible, ok.body.data.widgets[0].banner.degradedMetrics], [false, []], 'dados fresh: sem aviso');
  assert.equal(ok.body.data.quality.summary, 'OK');
  const stale = await openPanel(env, 'crm', { perms: CRM_USER, query: 'asOf=2026-10-20' });
  assert.equal(stale.status, 200, 'data-base sem snapshot: o painel abre e todos os cartões saem sem dado');
  assert.equal(stale.body.data.widgets[0].type, 'QUALITY_BANNER');
  assert.equal(stale.body.data.widgets[0].banner.visible, true);
  assert.equal(stale.body.data.widgets[0].banner.degradedMetrics.length, 14, 'os 14 indicadores listados na faixa, que é o primeiro bloco');
  assert.equal(stale.body.data.quality.summary, 'ATENCAO');
});

test('m9d634 rótulos de natureza presentes', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  const widgets = metricWidgets(res);
  assert.equal(widgets.length, 14);
  for (const w of widgets) {
    assert.ok(NATURES.includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
    assert.ok(['ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED'].includes(w.metric.valueNature), w.metricCode);
    assert.ok(w.metric.freshness && w.metric.freshness.state === 'FRESH' && /Atualizado às/.test(w.metric.freshness.label), `${w.metricCode}: selo de freshness`);
    assert.ok(Number.isInteger(w.metric.version) && w.metric.version >= 1, `${w.metricCode}: versão da métrica no tooltip`);
  }
});

test('m9d634 valores da tela iguais aos do endpoint de métrica', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  assert.equal(metricWidgets(res).length, 14, 'os 14 indicadores do painel');
  for (const w of metricWidgets(res)) {
    const direct = await getMetric(env, w.metricCode, CRM_USER);
    assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
    const d = direct.body.data;
    assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature], [d.value, d.status, d.version, d.unit, d.valueNature], w.metricCode);
    assert.equal(Number(w.metric.value), Number(seeded[w.metricCode].result.value), `${w.metricCode}: igual ao resultado gravado`);
  }
});

test('m9d634 valores em pt-BR vêm formatados pelo servidor', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  const by = Object.fromEntries(metricWidgets(res).map((w) => [w.metricCode, w]));
  const stage = by['crm.opportunities_by_stage'];
  assert.match(stage.metric.formatted, /^\d{1,3}(\.\d{3})*$/, 'contagem com separador de milhar pt-BR');
  const conv = by['crm.conversion_rate'];
  assert.match(conv.metric.formatted, /^\d+,\d{2}%$/, 'percentual com vírgula decimal');
  const proposals = by['crm.proposals'].view.facts.find((f) => f.key === 'valor_total_brl');
  assert.match(proposals.formatted, /^R\$ \d{1,3}(\.\d{3})*,\d{2}$/, 'dinheiro em reais com vírgula decimal');
});

test('m9d634 KPI DEGRADED mostra Dado incompleto no lugar do valor', async () => {
  const lead = ['crm.leads_by_origin', 'crm.first_response_time', 'crm.opportunities_by_stage', 'crm.conversion_rate', 'crm.loss_reasons', 'crm.portfolio_without_next_action'];
  await cleanup(env, env.tenantA);
  await env634.publishAll(env.tenantA);
  await seedPanel(env.tenantA, CRM_PANEL, { degraded: lead });
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  const widgets = metricWidgets(res);
  for (const c of lead) {
    const w = widgets.find((x) => x.metricCode === c);
    assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], c);
    assert.deepEqual(w.view.items || [], [], `${c}: sem barras quando o dado está incompleto`);
  }
  const banner = res.body.data.widgets[0].banner;
  assert.deepEqual(banner.degradedMetrics.map((m) => m.metricCode).sort(), [...lead].sort());
  assert.ok(banner.visible && banner.degradedMetrics.every((m) => m.problem === 'DEGRADED' && m.reason === 'Dado incompleto'));
  const direct = await getMetric(env, 'crm.opportunities_by_stage', CRM_USER);
  assert.equal(direct.body.data.value, null, 'a mesma regra no endpoint de métrica');
  await cleanup(env, env.tenantA);
  await env634.publishAll(env.tenantA);
  seeded = await seedPanel(env.tenantA, CRM_PANEL);
});

test('m9d634 funil na ordem do parâmetro, com o tempo parado de cada estágio', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  const w = metricWidgets(res).find((x) => x.metricCode === 'crm.opportunities_by_stage');
  assert.equal(w.view.chart, 'FUNNEL');
  const ids = w.view.items.map((i) => i.id);
  const gravado = seeded['crm.opportunities_by_stage'].result.dimensions.filter((d) => /^estagio:[^:]+$/.test(d.key));
  assert.deepEqual([...ids].sort(), gravado.map((d) => d.key.split(':')[1]).sort(), 'todos os estágios gravados e nenhum a mais');
  assert.ok(w.view.items[0].formatted && w.view.items.every((i) => i.formatted !== null));
  const order = 'NEW,QUALIFIED,MATCHING,VISIT_SCHEDULED,VISITED,PROPOSAL,FINANCING,CONTRACT,NURTURE,CLOSED_WON,CLOSED_LOST,WITHDRAWN'.split(',');
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : 99);
  assert.deepEqual(ids, [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)), 'ordem do funil do administrador');
  const idle = w.view.items.find((i) => (i.extra || []).length);
  assert.ok(idle.extra[0].formatted.endsWith(' dias'), 'tempo parado em dias, já formatado');
  assert.ok(w.view.highlight && w.view.highlight.key === 'paradas_qtd');
});

test('m9d634 ordem do funil acompanha o parâmetro do administrador', async () => {
  const t = env.tenantA;
  await env.admin.query(
    "INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, 'analytics.comercial.ordem_estagios', CAST(:v AS jsonb))",
    { replacements: { g: t.groupId, c: t.companyId, v: JSON.stringify('WITHDRAWN,CLOSED_LOST,CLOSED_WON,NEW,NEGOCIACAO') } }
  );
  try {
    const res = await openPanel(env, 'crm', { perms: CRM_USER });
    const ids = metricWidgets(res).find((x) => x.metricCode === 'crm.opportunities_by_stage').view.items.map((i) => i.id);
    const wanted = ['WITHDRAWN', 'CLOSED_LOST', 'CLOSED_WON', 'NEW'].filter((id) => ids.includes(id));
    assert.deepEqual(ids.filter((id) => wanted.includes(id)), wanted, 'os estágios do parâmetro vêm na ordem dele');
  } finally {
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.comercial.ordem_estagios'", { replacements: { c: t.companyId } });
  }
});

test('m9d634 detalhe: Ver detalhe só com permissão e agregado no 403', async () => {
  const withDetail = await openPanel(env, 'crm', { perms: [...CRM_USER, 'analytics:drilldown'] });
  const wd = metricWidgets(withDetail);
  const stage = wd.find((w) => w.metricCode === 'crm.opportunities_by_stage');
  assert.deepEqual([stage.drilldown.enabled, stage.drilldown.allowed], [true, true]);
  assert.ok(stage.drilldown.sourceRef.filterHash && stage.drilldown.sourceRef.filterSignature && stage.drilldown.sourceRef.filter);
  const portfolio = wd.find((w) => w.metricCode === 'crm.portfolio_without_next_action');
  assert.deepEqual([portfolio.drilldown.enabled, portfolio.view.link.href], [false, '/painel/crm'], 'indicador NORMAL (M9-D712): o cartão abre a lista de oportunidades');
  const plain = wd.find((w) => w.metricCode === 'crm.conversion_rate');
  assert.deepEqual([plain.drilldown.enabled, plain.drilldown.allowed, plain.drilldown.sourceRef], [false, false, null], 'indicador sem detalhe não mostra o botão');

  const ref = stage.drilldown.sourceRef;
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, pageSize: '50' }).toString();
  const ok = await env.call('GET', `/analytics/metrics/crm.opportunities_by_stage/drilldown?${q}`, { perms: [...CRM_USER, 'analytics:drilldown'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const without = await openPanel(env, 'crm', { perms: CRM_USER });
  const denied = metricWidgets(without).find((w) => w.metricCode === 'crm.opportunities_by_stage');
  assert.deepEqual([denied.drilldown.enabled, denied.drilldown.allowed], [true, false], 'sem analytics:drilldown o servidor não libera o botão');
  const refused = await env.call('GET', `/analytics/metrics/crm.opportunities_by_stage/drilldown?${q}`, { perms: CRM_USER });
  assert.equal(refused.status, 403);
  assert.equal(code(refused), 'ANALYTICS_DRILLDOWN_FORBIDDEN');
  assert.ok(refused.body.error.details.aggregate !== undefined, 'o 403 traz o agregado permitido para a tela mostrar');
});

test('m9d634 painel sem permissão devolve 403', async () => {
  const none = await openPanel(env, 'crm', { perms: [] });
  assert.equal(none.status, 403);
  assert.equal(code(none), 'PERMISSION_DENIED');
  const noDomain = await openPanel(env, 'crm', { perms: ['analytics:read'] });
  assert.equal(noDomain.status, 403);
  assert.equal(code(noDomain), 'PERMISSION_DENIED');
  assert.match(noDomain.body.error.message, /crm:opportunities:read/, 'diz qual permissão do domínio falta');
  const onlyDomain = await openPanel(env, 'crm', { perms: ['crm:opportunities:read'] });
  assert.equal(onlyDomain.status, 403, 'a rota do BI exige analytics:read em qualquer painel');
});

test('m9d634 painel inexistente e empresa de outro grupo respondem 404', async () => {
  const missing = await openPanel(env, 'nao_existe', { perms: CRM_USER });
  assert.equal(missing.status, 404);
  assert.equal(code(missing), 'ANALYTICS_DASHBOARD_NOT_FOUND');
  assert.equal(missing.body.error.message, 'Painel não encontrado.');
  const other = await openPanel(env, 'crm', { perms: CRM_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.equal(other.status, 404);
  assert.equal(code(other), 'ANALYTICS_SCOPE_NOT_FOUND');
  const asB = await openPanel(env, 'crm', { perms: CRM_USER, tenant: 'B', query: `asOf=${AS_OF}` });
  assert.equal(asB.status, 200, 'a empresa B abre o painel');
  assert.ok(metricWidgets(asB).every((w) => w.metric.incomplete), 'e não vê nenhum número da empresa A');
});

test('m9d634 data-base futura é recusada', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER, query: 'asOf=2030-01-01' });
  assert.equal(res.status, 400);
});
