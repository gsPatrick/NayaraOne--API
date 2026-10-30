'use strict';

// M9-D634 (critério trazido da M9-D632 e da M9-D633) — painel Vendas/CRM: os oito indicadores de visitas, propostas, imóveis e corretores, quando vêm
// DEGRADED, saem com valor nulo e o texto "Dado incompleto" no lugar do número (o Front só exibe `incompleteText`). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env634 = require('../_helpers/painelBiEnv');
const { CRM_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { CRM_USER, openPanel, getMetric, seedPanel, cleanup } = env634;
const EIGHT = ['crm.visits', 'crm.proposals', 'prop.active_properties', 'prop.without_sale_by_period', 'prop.price_changes', 'radar.matches', 'crm.broker_capture', 'crm.broker_conversion'];
let env;

before(async () => { env = await env634.setup(); });
after(() => env634.teardown(env));

test('m9d634 os oito indicadores de D632 e D633 estão no painel e mostram Dado incompleto quando DEGRADED', async () => {
  await cleanup(env, env.tenantA);
  await env634.publishAll(env.tenantA);
  await seedPanel(env.tenantA, CRM_PANEL, { degraded: EIGHT });
  try {
    const res = await openPanel(env, 'crm', { perms: CRM_USER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const widgets = res.body.data.widgets.filter((w) => w.metric);
    for (const c of EIGHT) {
      const w = widgets.find((x) => x.metricCode === c);
      assert.ok(w, `${c} está no painel`);
      assert.deepEqual([w.metric.incomplete, w.metric.value, w.metric.formatted, w.metric.incompleteText, w.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED'], c);
      assert.deepEqual(w.view.items || [], [], `${c}: sem barras nem linhas quando o dado está incompleto`);
      const direct = await getMetric(env, c, CRM_USER);
      assert.equal(direct.body.data.value, null, `${c}: a mesma regra no endpoint de métrica`);
    }
    const banner = res.body.data.widgets[0].banner;
    assert.deepEqual(banner.degradedMetrics.map((m) => m.metricCode).sort(), [...EIGHT].sort());
  } finally {
    await cleanup(env, env.tenantA);
    await env634.publishAll(env.tenantA);
  }
});

test('m9d634 com o dado íntegro os oito indicadores trazem valor e não mostram Dado incompleto', async () => {
  await seedPanel(env.tenantA, CRM_PANEL);
  const res = await openPanel(env, 'crm', { perms: CRM_USER });
  for (const c of EIGHT) {
    const w = res.body.data.widgets.find((x) => x.metricCode === c);
    assert.notEqual(w.metric.incomplete, true, c);
    assert.notEqual(w.metric.incompleteText, 'Dado incompleto', c);
  }
});
