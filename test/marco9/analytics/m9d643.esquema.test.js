'use strict';

// M9-D643 — o painel Locação lê só o schema analytics (BI-012), responde dentro da meta p95 (1.500 ms), está publicado como versão 2 da definição global com a permissão legal:read e a
// migration do conteúdo é idempotente e reversível. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envRent = require('../_helpers/painelLocEnv');
const q = require('../_helpers/m9d698Queries');
const migration = require('../../../migrations/20260101009909-publish-analytics-rental-dashboard-content');
const { RENTAL_PANEL } = require('../../../src/features/analytics/dashboards/panels');
const catalog = require('../../../src/features/analytics/dashboards/dashboard.catalog');

const { RENT_USER, openPanel, seedPanel } = envRent;
let env;
before(async () => { env = await envRent.setup(); await seedPanel(env.tenantA, RENTAL_PANEL); });
after(() => envRent.teardown(env));

const globalRows = () => env.admin.query(
  "SELECT id, version, status, p95_target_ms, required_permission FROM analytics.dashboard_definitions WHERE dashboard_code = 'rental' AND company_id IS NULL AND group_id IS NULL ORDER BY version"
).then(([rows]) => rows);

test('m9d643 painel toca só schema analytics', async () => {
  const run = await q.capture(env.admin, async () => {
    for (let i = 0; i < 20; i += 1) assert.equal((await openPanel(env, 'rental', { perms: [...RENT_USER, 'analytics:drilldown'] })).status, 200);
  });
  assert.ok(run.sql.length >= 100, `a instrumentação viu só ${run.sql.length} consultas`);
  assert.ok(run.sql.some((s) => /analytics\.metric_snapshots/i.test(s)));
  assert.deepEqual(run.sources, [], `tabela de origem tocada:\n${run.sources.slice(0, 3).join('\n')}`);
});

test('m9d643 p95 dentro da meta da definição', async () => {
  const target = (await globalRows()).find((r) => r.status === 'PUBLISHED').p95_target_ms;
  assert.equal(target, 1500, 'meta do livro');
  const times = [];
  for (let i = 0; i < 40; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await openPanel(env, 'rental', { perms: [...RENT_USER, 'analytics:drilldown'] });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(res.status, 200);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  assert.ok(p95 <= target, `p95 ${p95.toFixed(0)} ms acima da meta de ${target} ms`);
});

test('m9d643 versão 2 vigente, com legal:read e exatamente os widgets do livro', async () => {
  const rows = await globalRows();
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
  assert.equal(rows[1].required_permission, 'legal:read');
  assert.equal(catalog.DASHBOARD_CATALOG.find((p) => p.code === 'rental').requiredPermission, 'legal:read');
  const [widgets] = await env.admin.query('SELECT position, widget_type, metric_code FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position', { replacements: { id: rows[1].id } });
  assert.deepEqual(widgets.map((w) => [w.position, w.widget_type, w.metric_code]), RENTAL_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
  assert.equal(widgets.length, 10, 'faixa de qualidade e os nove indicadores dos oito blocos');
});

test('m9d643 migration do conteúdo é idempotente e reversível', async () => {
  await migration.up({ sequelize: env.admin });
  assert.equal((await globalRows()).length, 2, 'rodar de novo não cria versão');
  await migration.down({ sequelize: env.admin });
  assert.deepEqual((await globalRows()).map((r) => [r.version, r.status]), [[1, 'PUBLISHED']]);
  await migration.up({ sequelize: env.admin });
  const rows = await globalRows();
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
  assert.equal(rows[1].required_permission, 'legal:read');
});

test('m9d643 o painel só mostra o que a API devolve: a busca por soma e divisão no código do Front não acha nada', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: path.join(__dirname, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
});
