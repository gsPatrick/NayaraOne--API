'use strict';

// M9-D634 — o painel Vendas/CRM lê só o schema analytics (BI-012), responde dentro da meta p95 da definição, está publicado como versão 2 da definição
// global (a 1 aposentada) e a migration do conteúdo é idempotente e reversível. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { robustP95 } = require('../_helpers/medicaoRobusta');
const env634 = require('../_helpers/painelBiEnv');
const q = require('../_helpers/m9d698Queries');
const migration = require('../../../migrations/20260101009834-publish-analytics-crm-dashboard-content');
const { CRM_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { CRM_USER, openPanel, seedPanel } = env634;
let env;
before(async () => { env = await env634.setup(); await seedPanel(env.tenantA, CRM_PANEL); });
after(() => env634.teardown(env));

const globalRows = () => env.admin.query(
  "SELECT id, version, status, p95_target_ms, required_permission FROM analytics.dashboard_definitions WHERE dashboard_code = 'crm' AND company_id IS NULL AND group_id IS NULL ORDER BY version"
).then(([rows]) => rows);

test('m9d634 painel toca só schema analytics', async () => {
  const run = await q.capture(env.admin, async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await openPanel(env, 'crm', { perms: [...CRM_USER, 'analytics:drilldown'] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  });
  assert.ok(run.sql.length >= 100, `a instrumentação viu só ${run.sql.length} consultas`);
  assert.ok(run.sql.some((s) => /analytics\.metric_snapshots/i.test(s)), 'a leitura dos snapshots aparece no SQL capturado');
  assert.deepEqual(run.sources, [], `tabela de origem tocada:\n${run.sources.slice(0, 3).join('\n')}`);
});

test('m9d634 p95 dentro da meta da definição', async () => {
  const [{ p95_target_ms: target }] = (await globalRows()).filter((r) => r.status === 'PUBLISHED');
  assert.equal(target, 1500, 'meta do livro para o painel Vendas/CRM');
  // DI-M9F-4: tempo da operação medido no servidor (sem o cliente HTTP), 5 aberturas de aquecimento e a mediana do p95 de 3 séries de 20; a meta é a da definição
  const { p95, series } = await robustP95(async () => {
    const res = await openPanel(env, 'crm', { perms: [...CRM_USER, 'analytics:drilldown'] }); // cache limpo: a composição inteira roda
    assert.equal(res.status, 200);
    return res.serverMs;
  });
  assert.ok(p95 <= target, `p95 ${p95.toFixed(0)} ms acima da meta de ${target} ms (p95 das séries: ${series.map((x) => x.toFixed(0)).join(', ')} ms)`);
});

test('m9d634 versão 2 vigente, versão 1 aposentada e widgets iguais aos do livro', async () => {
  const rows = await globalRows();
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
  assert.equal(rows[1].required_permission, 'crm:opportunities:read', 'permissão do domínio no mapa da M9-D700');
  const [widgets] = await env.admin.query('SELECT position, widget_type, metric_code, drilldown_enabled FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position', { replacements: { id: rows[1].id } });
  assert.deepEqual(widgets.map((w) => [w.position, w.widget_type, w.metric_code]), CRM_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
  assert.equal(widgets[0].widget_type, 'QUALITY_BANNER');
});

test('m9d634 migration do conteúdo é idempotente e reversível', async () => {
  await migration.up({ sequelize: env.admin });
  assert.equal((await globalRows()).length, 2, 'rodar de novo não cria versão');
  await migration.down({ sequelize: env.admin });
  assert.deepEqual((await globalRows()).map((r) => [r.version, r.status]), [[1, 'PUBLISHED']]);
  await migration.up({ sequelize: env.admin });
  assert.deepEqual((await globalRows()).map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
});
