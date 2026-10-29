'use strict';

// M9-D673 — painéis Marketing (marketing) e Atendimento/Satisfação (support) pela rota real: widgets na ordem, faixa de qualidade primeiro, rótulos de natureza, valores iguais
// aos do endpoint de métrica, formato pt-BR, "Dado incompleto" nos KPIs degradados, alertas, detalhe só com permissão e recusas por painel. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env673 = require('../_helpers/painelMktSupEnv');
const { MARKETING_PANEL, SUPPORT_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { MKT_USER, SUP_USER, openPanel, getMetric, seedPanel, seedMetric, cleanup, publishAll } = env673;
const PANELS = [['marketing', MARKETING_PANEL, MKT_USER], ['support', SUPPORT_PANEL, SUP_USER]];
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const metricWidgets = (res) => res.body.data.widgets.filter((w) => w.metric);
const by = (res, c) => metricWidgets(res).find((w) => w.metricCode === c);
const MKT_CODES = ['mkt.campaigns', 'mkt.cost', 'mkt.leads', 'mkt.attribution', 'mkt.deliverability', 'mkt.opt_out', 'mkt.frequency', 'mkt.automations_blocked_failed'];
const SUP_CODES = ['sup.reviews', 'sup.satisfaction', 'sup.complaints_by_reason', 'sup.sla_resolution'];
let env;
let seeded;
const reseed = async (opts = {}) => {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  return { ...(await seedPanel(env.tenantA, MARKETING_PANEL, opts)), ...(await seedPanel(env.tenantA, SUPPORT_PANEL, opts)) };
};

before(async () => { env = await env673.setup(); seeded = await reseed(); });
after(() => env673.teardown(env));

test('m9d673 painel devolve widgets na ordem definida', async () => {
  for (const [name, panel, perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.dashboardCode, name);
    assert.deepEqual(res.body.data.widgets.map((w) => [w.position, w.type, w.metricCode]), panel.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]), name);
  }
  assert.deepEqual(metricWidgets(await openPanel(env, 'marketing', { perms: MKT_USER })).map((w) => w.metricCode), MKT_CODES, 'campanhas, custo, leads, atribuição; entregabilidade e opt-out; frequência e automações');
  assert.deepEqual(metricWidgets(await openPanel(env, 'support', { perms: SUP_USER })).map((w) => w.metricCode), SUP_CODES, 'reviews e satisfação; reclamações; SLA');
});

test('m9d673 faixa de qualidade vem antes dos números', async () => {
  for (const [name, , perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    const first = res.body.data.widgets[0];
    assert.deepEqual([first.type, first.position, first.banner.visible, first.banner.degradedMetrics], ['QUALITY_BANNER', 0, false, []], `${name}: dados frescos, sem aviso`);
    const old = await openPanel(env, name, { perms, query: 'asOf=2026-10-20' });
    assert.equal(old.body.data.widgets[0].type, 'QUALITY_BANNER');
    assert.equal(old.body.data.widgets[0].banner.degradedMetrics.length, name === 'marketing' ? 8 : 4, `${name}: os KPIs sem registro na data-base aparecem na faixa`);
  }
});

test('m9d673 rótulos de natureza presentes', async () => {
  for (const [name, , perms] of PANELS) {
    for (const w of metricWidgets(await openPanel(env, name, { perms }))) {
      assert.ok(['Realizado', 'Previsto', 'Estimado', 'Projetado'].includes(w.metric.valueNatureLabel), `${w.metricCode}: sem rótulo de natureza`);
      assert.equal(w.metric.valueNatureLabel, 'Realizado', `${w.metricCode}: KPI de natureza ACTUAL`);
      assert.equal(w.metric.freshness.state, 'FRESH', w.metricCode);
    }
  }
});

test('m9d673 valores do painel iguais aos do endpoint de métrica (a tela só desenha o que a API devolveu)', async () => {
  for (const [name, , perms] of PANELS) {
    const widgets = metricWidgets(await openPanel(env, name, { perms }));
    assert.equal(widgets.length, name === 'marketing' ? 8 : 4);
    for (const w of widgets) {
      const direct = await getMetric(env, w.metricCode, perms);
      assert.equal(direct.status, 200, `${w.metricCode}: ${JSON.stringify(direct.body)}`);
      const d = direct.body.data;
      assert.deepEqual([w.metric.value, w.metric.status, w.metric.version, w.metric.unit, w.metric.valueNature, w.metric.formatted], [d.value, d.status, d.version, d.unit, d.valueNature, d.formatted], w.metricCode);
      assert.equal(Number(w.metric.value), Number(seeded[w.metricCode].result.value), `${w.metricCode}: igual ao resultado gravado`);
    }
  }
});

test('m9d673 painel de marketing: custo, leads e custo por lead do mês em pt-BR, com a decomposição por canal', async () => {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  await seedMetric(env.tenantA, 'mkt.cost', { result: { value: '3200.00', status: 'OK', dimensions: [{ key: 'planejado_brl', value: '800.00' }, { key: 'canal:EMAIL:custo_brl', value: '1200.00' }, { key: 'canal:WHATSAPP:custo_brl', value: '2000.00' }] } });
  await seedMetric(env.tenantA, 'mkt.leads', { result: { value: '40', status: 'OK', dimensions: [{ key: 'sem_campanha_qtd', value: '4' }, { key: 'sem_campanha_pct', value: '10.00' }, { key: 'canal:EMAIL:leads_qtd', value: '15' }, { key: 'canal:WHATSAPP:leads_qtd', value: '25' }] } });
  await seedMetric(env.tenantA, 'mkt.attribution', { result: { value: '80.00', status: 'OK', dimensions: [{ key: 'leads_atribuidos_qtd', value: '40' }, { key: 'vendas_atribuidas_qtd', value: '2' }, { key: 'custo_por_venda_brl', value: '1600.00' }, { key: 'fora_da_janela_qtd', value: '1' }] } });
  const res = await openPanel(env, 'marketing', { perms: MKT_USER });
  const cost = by(res, 'mkt.cost');
  assert.deepEqual([cost.metric.formatted, cost.metric.unit], ['R$ 3.200,00', 'BRL']);
  assert.deepEqual(cost.view.items.map((i) => [i.id, i.cells[0].formatted]), [['WHATSAPP', 'R$ 2.000,00'], ['EMAIL', 'R$ 1.200,00']], 'maior custo primeiro');
  assert.equal(cost.view.facts[0].formatted, 'R$ 800,00');
  const leads = by(res, 'mkt.leads');
  assert.deepEqual([leads.metric.formatted, leads.view.facts.map((f) => f.formatted)], ['40', ['4', '10,00%']]);
  const attribution = by(res, 'mkt.attribution');
  assert.deepEqual([attribution.metric.formatted, attribution.view.facts.map((f) => f.formatted)], ['R$ 80,00', ['40', '2', 'R$ 1.600,00', '1']]);
  seeded = await reseed();
});

test('m9d673 frequência acima do teto e SLA vencido acendem o alerta do cartão; sem eles, não', async () => {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  const freq = (over) => ({ value: '3.20', status: 'OK', dimensions: [{ key: 'acima_do_teto_qtd', value: over }, { key: 'pessoas_alcancadas_qtd', value: '50' }, { key: 'mensagens_qtd', value: '160' }, { key: 'canal:EMAIL:media', value: '3.20' }] });
  const sla = (late) => ({ value: '80.00', status: 'OK', dimensions: [{ key: 'resolvidos_qtd', value: '10' }, { key: 'dentro_do_sla_qtd', value: '8' }, { key: 'abertos_vencidos_qtd', value: late }, { key: 'prioridade:ALTA:resolvidos_qtd', value: '4' }, { key: 'prioridade:ALTA:dentro_pct', value: '75.00' }] });
  await seedMetric(env.tenantA, 'mkt.frequency', { result: freq('3') });
  await seedMetric(env.tenantA, 'sup.sla_resolution', { result: sla('2') });
  assert.equal(by(await openPanel(env, 'marketing', { perms: MKT_USER }), 'mkt.frequency').view.alert, true);
  const slaWidget = by(await openPanel(env, 'support', { perms: SUP_USER }), 'sup.sla_resolution');
  assert.equal(slaWidget.view.alert, true);
  assert.deepEqual(slaWidget.view.items.map((i) => [i.id, i.cells.map((c) => c.formatted)]), [['ALTA', ['75,00%', '4']]]);
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  await seedMetric(env.tenantA, 'mkt.frequency', { result: freq('0') });
  await seedMetric(env.tenantA, 'sup.sla_resolution', { result: sla('0') });
  assert.equal(by(await openPanel(env, 'marketing', { perms: MKT_USER }), 'mkt.frequency').view.alert, false);
  assert.equal(by(await openPanel(env, 'support', { perms: SUP_USER }), 'sup.sla_resolution').view.alert, false);
  seeded = await reseed();
});

test('m9d673 painel de atendimento: reclamações por motivo com quantidade e participação, reviews por plataforma e satisfação em pt-BR', async () => {
  await cleanup(env, env.tenantA);
  await publishAll(env.tenantA);
  await seedMetric(env.tenantA, 'sup.complaints_by_reason', { result: { value: '20', status: 'OK', dimensions: [{ key: 'motivo:COMPLAINT:qtd', value: '12' }, { key: 'motivo:COMPLAINT:pct', value: '60.00' }, { key: 'motivo:CONFLICT:qtd', value: '8' }, { key: 'motivo:CONFLICT:pct', value: '40.00' }] } });
  await seedMetric(env.tenantA, 'sup.reviews', { result: { value: '4.60', status: 'OK', dimensions: [{ key: 'reviews_qtd', value: '5' }, { key: 'nota_5_qtd', value: '3' }, { key: 'nota_4_qtd', value: '2' }, { key: 'plataforma:GOOGLE:reviews_qtd', value: '5' }, { key: 'plataforma:GOOGLE:nota_media', value: '4.60' }] } });
  await seedMetric(env.tenantA, 'sup.satisfaction', { result: { value: '4.20', status: 'OK', dimensions: [{ key: 'respostas_qtd', value: '5' }, { key: 'notas_4_5_qtd', value: '4' }, { key: 'notas_4_5_pct', value: '80.00' }] } });
  const res = await openPanel(env, 'support', { perms: SUP_USER });
  const complaints = by(res, 'sup.complaints_by_reason');
  assert.equal(complaints.metric.formatted, '20');
  assert.deepEqual(complaints.view.items.map((i) => [i.id, i.cells.map((c) => c.formatted)]), [['COMPLAINT', ['12', '60,00%']], ['CONFLICT', ['8', '40,00%']]], 'maior motivo primeiro');
  const reviews = by(res, 'sup.reviews');
  assert.equal(reviews.metric.formatted, '4,60');
  assert.deepEqual(reviews.view.items.map((i) => [i.id, i.cells.map((c) => c.formatted)]), [['GOOGLE', ['4,60', '5']]]);
  const csat = by(res, 'sup.satisfaction');
  assert.deepEqual([csat.metric.formatted, csat.view.facts.map((f) => f.formatted)], ['4,20', ['5', '4', '80,00%']]);
  seeded = await reseed();
});

test('m9d673 KPI de Marketing e de Atendimento DEGRADED ou INCOMPLETE mostra Dado incompleto no lugar do número', async () => {
  await reseed({ degraded: [...MKT_CODES, ...SUP_CODES] });
  for (const [name, , perms] of PANELS) {
    const res = await openPanel(env, name, { perms });
    const widgets = metricWidgets(res);
    assert.equal(widgets.length, name === 'marketing' ? 8 : 4);
    for (const w of widgets) {
      assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], w.metricCode);
      assert.ok((w.view.series || []).every((s) => s.value === null && s.formatted === null), `${w.metricCode}: nenhuma série com número`);
      assert.deepEqual([w.view.items || [], w.view.facts || []], [[], []], `${w.metricCode}: nenhuma linha nem fato com número`);
    }
    const banner = res.body.data.widgets[0].banner;
    assert.deepEqual([banner.visible, banner.degradedMetrics.length], [true, widgets.length], `${name}: faixa antes dos cartões`);
  }
  seeded = await reseed();
});

test('m9d673 detalhe só com permissão: os KPIs destes painéis são NORMAL e não oferecem detalhe de BI (o botão só aparece onde a API liberar)', async () => {
  for (const [name, , perms] of PANELS) {
    for (const w of metricWidgets(await openPanel(env, name, { perms: [...perms, 'analytics:drilldown'] }))) {
      assert.deepEqual([w.drilldown.enabled, w.drilldown.allowed], [false, false], `${w.metricCode}: indicador NORMAL sem detalhe de BI`);
    }
  }
  const complaints = by(await openPanel(env, 'support', { perms: SUP_USER }), 'sup.complaints_by_reason');
  assert.deepEqual(complaints.view.link, { href: '/painel/crm/feedback', label: 'Ver reclamações' }, 'a tela de lista do módulo é o caminho para os registros');
});

test('m9d673 painel sem permissão devolve 403', async () => {
  for (const name of ['marketing', 'support']) {
    assert.equal((await openPanel(env, name, { perms: [] })).status, 403, name);
    const only = await openPanel(env, name, { perms: ['analytics:read'] });
    assert.deepEqual([only.status, code(only)], [403, 'PERMISSION_DENIED'], name);
  }
  assert.match((await openPanel(env, 'marketing', { perms: ['analytics:read'] })).body.error.message, /marketing:attribution:read/);
  assert.match((await openPanel(env, 'support', { perms: ['analytics:read'] })).body.error.message, /crm:feedback:read/);
  assert.equal((await openPanel(env, 'support', { perms: MKT_USER })).status, 403, 'marketing:attribution:read não abre o painel de Atendimento');
  assert.equal((await openPanel(env, 'marketing', { perms: SUP_USER })).status, 403, 'crm:feedback:read não abre o painel de Marketing');
  assert.equal((await openPanel(env, 'marketing', { perms: ['marketing:attribution:read'] })).status, 403, 'sem analytics:read nenhum painel abre');
  const missing = await openPanel(env, 'atendimento', { perms: SUP_USER });
  assert.deepEqual([missing.status, code(missing)], [404, 'ANALYTICS_DASHBOARD_NOT_FOUND']);
  const other = await openPanel(env, 'marketing', { perms: MKT_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.deepEqual([other.status, code(other)], [404, 'ANALYTICS_SCOPE_NOT_FOUND']);
});
