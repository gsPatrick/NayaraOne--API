'use strict';

// M9-D702 — GET /analytics/dashboards/:code pela rota real (painel Vendas/CRM): todos os widgets numa resposta, faixa de qualidade primeiro, o objeto de
// indicador igual ao da rota de métrica, período, parâmetro desconhecido e as recusas. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env634 = require('../_helpers/painelBiEnv');
const { CRM_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { AS_OF, CRM_USER, openPanel, getMetric, seedPanel } = env634;
const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const message = (res) => res.body.message || (res.body.error && res.body.error.message);
const CONTRACT = ['name', 'version', 'unit', 'valueNature', 'value', 'formatted', 'status', 'valueReliable', 'period', 'freshness', 'quality', 'sourceRefs', 'components', 'variation', 'drilldown', 'owner'];
let env;

before(async () => {
  env = await env634.setup();
  await seedPanel(env.tenantA, CRM_PANEL, { degraded: ['crm.loss_reasons'] });
});
after(() => env634.teardown(env));

test('m9d702 painel devolve todos os widgets numa resposta, na ordem, com a faixa de qualidade primeiro', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.dashboardCode, 'crm');
  assert.ok(Number.isInteger(d.version) && d.version >= 1);
  assert.ok(d.generatedAt);
  assert.deepEqual([d.widgets[0].type, d.widgets[0].position], ['QUALITY_BANNER', 0], 'a faixa de qualidade vem primeiro');
  assert.deepEqual(d.widgets.map((w) => w.position), d.widgets.map((_, i) => i));
  assert.equal(d.widgets.length, 15);
  assert.equal(d.quality.summary, 'ATENCAO');
  assert.deepEqual(d.quality.degradedMetrics.map((m) => m.metricCode), ['crm.loss_reasons']);
  for (const w of d.widgets) for (const k of ['position', 'type', 'title', 'valueNature', 'drilldownEnabled']) assert.ok(k in w, `widget sem ${k}`);
  assert.deepEqual(d.period, { start: '2026-10-01', end: '2026-10-31', asOf: AS_OF, tz: 'America/Sao_Paulo', label: 'outubro de 2026', kind: 'MONTH' });
});

test('m9d702 o metric de cada widget tem o contrato da rota de métrica e os mesmos valores', async () => {
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  const widgets = res.body.data.widgets.filter((w) => w.metric);
  assert.equal(widgets.length, 14);
  for (const w of widgets) {
    for (const k of CONTRACT) assert.ok(k in w.metric, `${w.metric.metricCode}: falta ${k}`);
    if (w.metric.metricCode === 'crm.loss_reasons') {
      assert.deepEqual([w.metric.value, w.metric.formatted, w.metric.status], [null, null, 'DEGRADED'], 'degradado sai sem número');
      assert.ok(w.metric.quality.degradedReasons.length === 0 || Array.isArray(w.metric.quality.degradedReasons));
      continue;
    }
    const alone = await getMetric(env, w.metric.metricCode, CRM_USER);
    assert.equal(alone.status, 200, `${w.metric.metricCode}: ${JSON.stringify(alone.body)}`);
    for (const k of ['value', 'formatted', 'unit', 'version', 'valueNature', 'status', 'owner', 'components', 'period', 'drilldown']) {
      assert.deepEqual(w.metric[k], alone.body.data[k], `${w.metric.metricCode}.${k}`);
    }
  }
});

test('m9d702 painel aceita period e asOf e rejeita parâmetro desconhecido e período inválido', async () => {
  const month = await openPanel(env, 'crm', { perms: CRM_USER, query: 'period=2026-10' });
  assert.equal(month.status, 200, JSON.stringify(month.body));
  assert.equal(month.body.data.period.asOf, AS_OF);
  const sep = await openPanel(env, 'crm', { perms: CRM_USER, query: 'period=2026-09' });
  assert.equal(sep.status, 200);
  assert.deepEqual([sep.body.data.period.start, sep.body.data.period.asOf], ['2026-09-01', '2026-09-30']);
  assert.equal(sep.body.data.quality.summary, 'ATENCAO', 'sem snapshot em 30/09 os cartões saem sem dado');
  const unknown = await openPanel(env, 'crm', { perms: CRM_USER, query: 'periodo=2026-10' });
  assert.equal(unknown.status, 400);
  assert.equal(code(unknown), 'ANALYTICS_QUERY_PARAM_UNKNOWN');
  assert.equal(message(unknown), 'Parâmetro de consulta desconhecido: periodo.');
  const bad = await openPanel(env, 'crm', { perms: CRM_USER, query: 'period=2026-13' });
  assert.equal(bad.status, 400);
  assert.equal(code(bad), 'ANALYTICS_PERIOD_INVALID');
  const both = await openPanel(env, 'crm', { perms: CRM_USER, query: 'period=2026-10&year=2026' });
  assert.equal(code(both), 'ANALYTICS_PERIOD_INVALID');
});

test('m9d702 painel: 403 sem permissão, 404 inexistente e 404 de empresa alheia', async () => {
  const none = await openPanel(env, 'crm', { perms: [] });
  assert.equal(none.status, 403);
  assert.equal(code(none), 'PERMISSION_DENIED');
  assert.equal(message(none), 'Permissão ausente: analytics:read.');
  const noDomain = await openPanel(env, 'crm', { perms: ['analytics:read'] });
  assert.equal(noDomain.status, 403, 'painel de outro domínio');
  const missing = await openPanel(env, 'nao_existe', { perms: CRM_USER });
  assert.equal(missing.status, 404);
  assert.equal(code(missing), 'ANALYTICS_DASHBOARD_NOT_FOUND');
  assert.equal(message(missing), 'Painel não encontrado.');
  const foreign = await openPanel(env, 'crm', { perms: CRM_USER, query: `companyId=${env.tenantB.companyId}` });
  assert.equal(foreign.status, 404);
  assert.equal(code(foreign), 'ANALYTICS_SCOPE_NOT_FOUND');
});
