'use strict';

// M9-D662 — os painéis Jurídico e Correspondente leem só o schema analytics (BI-012), respondem dentro da meta p95 (1.800 ms), estão publicados como
// versão 2 das definições globais e a migration do conteúdo é idempotente e reversível. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { robustP95 } = require('../_helpers/medicaoRobusta');
const env662 = require('../_helpers/painelBiEnv');
const q = require('../_helpers/m9d698Queries');
const migration = require('../../../migrations/20260101009835-publish-analytics-legal-correspondent-dashboard-content');
const { LEGAL_PANEL, CORRESPONDENT_PANEL } = require('../../../src/features/analytics/dashboards/panels');

const { LEGAL_USER, COR_USER, openPanel, seedPanel } = env662;
const CASES = [['legal', LEGAL_PANEL, LEGAL_USER, 'legal:read'], ['correspondent', CORRESPONDENT_PANEL, COR_USER, 'correspondent:read']];
let env;
before(async () => { env = await env662.setup(); for (const [, panel] of CASES) await seedPanel(env.tenantA, panel); });
after(() => env662.teardown(env));

const globalRows = (code) => env.admin.query(
  'SELECT id, version, status, p95_target_ms, required_permission FROM analytics.dashboard_definitions WHERE dashboard_code = :code AND company_id IS NULL AND group_id IS NULL ORDER BY version',
  { replacements: { code } }
).then(([rows]) => rows);

test('m9d662 painel toca só schema analytics', async () => {
  const run = await q.capture(env.admin, async () => {
    for (let i = 0; i < 20; i += 1) {
      for (const [name, , perms] of CASES) assert.equal((await openPanel(env, name, { perms: [...perms, 'analytics:drilldown'] })).status, 200);
    }
  });
  assert.ok(run.sql.length >= 100, `a instrumentação viu só ${run.sql.length} consultas`);
  assert.ok(run.sql.some((s) => /analytics\.metric_snapshots/i.test(s)));
  assert.deepEqual(run.sources, [], `tabela de origem tocada:\n${run.sources.slice(0, 3).join('\n')}`);
});

test('m9d662 p95 dentro da meta da definição', async () => {
  for (const [name, , perms] of CASES) {
    const target = (await globalRows(name)).find((r) => r.status === 'PUBLISHED').p95_target_ms;
    assert.equal(target, 1800, `${name}: meta do livro`);
    // DI-M9F-4: tempo da operação medido no servidor (sem o cliente HTTP), 5 aberturas de aquecimento e a mediana do p95 de 3 séries de 20; a meta é a da definição
    const { p95, series } = await robustP95(async () => {
      const res = await openPanel(env, name, { perms: [...perms, 'analytics:drilldown'] });
      assert.equal(res.status, 200);
      return res.serverMs;
    });
    assert.ok(p95 <= target, `${name}: p95 ${p95.toFixed(0)} ms acima da meta de ${target} ms (p95 das séries: ${series.map((x) => x.toFixed(0)).join(', ')} ms)`);
  }
});

test('m9d662 versão 2 vigente de cada painel, com a permissão do domínio e os widgets do livro', async () => {
  for (const [name, panel, , permission] of CASES) {
    const rows = await globalRows(name);
    assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']], name);
    assert.equal(rows[1].required_permission, permission, name);
    const [widgets] = await env.admin.query('SELECT position, widget_type, metric_code FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position', { replacements: { id: rows[1].id } });
    assert.deepEqual(widgets.map((w) => [w.position, w.widget_type, w.metric_code]), panel.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]), name);
  }
});

test('m9d662 migration do conteúdo é idempotente e reversível', async () => {
  await migration.up({ sequelize: env.admin });
  for (const [name] of CASES) assert.equal((await globalRows(name)).length, 2, `${name}: rodar de novo não cria versão`);
  await migration.down({ sequelize: env.admin });
  for (const [name] of CASES) assert.deepEqual((await globalRows(name)).map((r) => [r.version, r.status]), [[1, 'PUBLISHED']], name);
  await migration.up({ sequelize: env.admin });
  for (const [name] of CASES) assert.deepEqual((await globalRows(name)).map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']], name);
});
