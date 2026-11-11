'use strict';

// M9-D626 — o painel Financeiro lê só o schema analytics (BI-012), responde dentro da meta p95 (1.500 ms), está publicado como versão 2 da definição global com a permissão
// finance:read, a migration do conteúdo é idempotente e reversível, o consolidado devolve o texto pt-BR pronto e os parâmetros do painel existem no esquema de configurações. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { robustP95 } = require('../_helpers/medicaoRobusta');
const envFin = require('../_helpers/painelFinEnv');
const q = require('../_helpers/m9d698Queries');
const migration = require('../../../migrations/20260101009908-publish-analytics-finance-dashboard-content');
const { FINANCE_PANEL } = require('../../../src/features/analytics/dashboards/panels');
const catalog = require('../../../src/features/analytics/dashboards/dashboard.catalog');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { PANEL_SETTINGS_SCHEMA } = require('../../../src/features/analytics/panelSettings');

const { FIN_USER, openPanel, seedMetric } = envFin;
let env;
before(async () => {
  env = await envFin.setup();
  for (const w of FINANCE_PANEL.widgets.filter((x) => x.metricCode)) await seedMetric(env.tenantA, w.metricCode);
});
after(() => envFin.teardown(env));

const globalRows = () => env.admin.query(
  "SELECT id, version, status, p95_target_ms, required_permission FROM analytics.dashboard_definitions WHERE dashboard_code = 'finance' AND company_id IS NULL AND group_id IS NULL ORDER BY version"
).then(([rows]) => rows);

test('m9d626 painel toca só schema analytics', async () => {
  const run = await q.capture(env.admin, async () => {
    for (let i = 0; i < 20; i += 1) assert.equal((await openPanel(env, 'finance', { perms: [...FIN_USER, 'analytics:drilldown'] })).status, 200);
  });
  assert.ok(run.sql.length >= 100, `a instrumentação viu só ${run.sql.length} consultas`);
  assert.ok(run.sql.some((s) => /analytics\.metric_snapshots/i.test(s)));
  assert.ok(run.sql.some((s) => /analytics\.alert_definitions/i.test(s)), 'o limiar do alerta publicado é lido do schema analytics');
  assert.deepEqual(run.sources, [], `tabela de origem tocada:\n${run.sources.slice(0, 3).join('\n')}`);
});

test('m9d626 p95 dentro da meta da definição', async () => {
  const target = (await globalRows()).find((r) => r.status === 'PUBLISHED').p95_target_ms;
  assert.equal(target, 1500, 'meta do livro');
  // DI-M9F-4: tempo da operação medido no servidor (sem o cliente HTTP), 5 aberturas de aquecimento e a mediana do p95 de 3 séries de 20; a meta é a da definição
  const { p95, series } = await robustP95(async () => {
    const res = await openPanel(env, 'finance', { perms: [...FIN_USER, 'analytics:drilldown'] });
    assert.equal(res.status, 200);
    return res.serverMs;
  });
  assert.ok(p95 <= target, `p95 ${p95.toFixed(0)} ms acima da meta de ${target} ms (p95 das séries: ${series.map((x) => x.toFixed(0)).join(', ')} ms)`);
});

test('m9d626 versão 2 vigente, com finance:read e os 13 widgets do livro', async () => {
  const rows = await globalRows();
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
  assert.equal(rows[1].required_permission, 'finance:read');
  assert.equal(catalog.DASHBOARD_CATALOG.find((p) => p.code === 'finance').requiredPermission, 'finance:read');
  const [widgets] = await env.admin.query('SELECT position, widget_type, metric_code FROM analytics.dashboard_widgets WHERE dashboard_id = :id ORDER BY position', { replacements: { id: rows[1].id } });
  assert.equal(widgets.length, 13);
  assert.deepEqual(widgets.map((w) => [w.position, w.widget_type, w.metric_code]), FINANCE_PANEL.widgets.map((w, i) => [i, w.widgetType, w.metricCode || null]));
});

test('m9d626 migration do conteúdo é idempotente e reversível', async () => {
  await migration.up({ sequelize: env.admin });
  assert.equal((await globalRows()).length, 2, 'rodar de novo não cria versão');
  await migration.down({ sequelize: env.admin });
  assert.deepEqual((await globalRows()).map((r) => [r.version, r.status]), [[1, 'PUBLISHED']]);
  await migration.up({ sequelize: env.admin });
  const rows = await globalRows();
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'RETIRED'], [2, 'PUBLISHED']]);
  assert.equal(rows[1].required_permission, 'finance:read');
});

test('m9d626 consolidado do grupo devolve o texto pt-BR pronto (o seletor Empresa/Grupo só desenha)', async () => {
  const perms = [...FIN_USER, 'analytics:read:group'];
  const res = await env.call('GET', `/analytics/metrics/fin.free_cash?asOf=${envFin.AS_OF}&groupId=${env.tenantA.groupId}`, { perms });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.match(d.formatted, /^R\$ /);
  assert.ok(d.byCompany.length >= 1 && d.byCompany.every((c) => 'formatted' in c), 'cada empresa traz o seu texto');
  assert.ok('eliminationsFormatted' in d && Array.isArray(d.warnings));
  const forbidden = await env.call('GET', `/analytics/metrics/fin.free_cash?asOf=${envFin.AS_OF}&groupId=${env.tenantA.groupId}`, { perms: FIN_USER });
  assert.deepEqual([forbidden.status, forbidden.body.code || forbidden.body.error.code], [403, 'ANALYTICS_GROUP_SCOPE_FORBIDDEN'], 'sem analytics:read:group o seletor oferece só a empresa');
});

test('m9d626 os parâmetros do painel estão no esquema de configurações e são lidos pelo painel', () => {
  for (const key of Object.keys(PANEL_SETTINGS_SCHEMA)) assert.ok(SETTINGS_SCHEMA[key], `${key} fora do SETTINGS_SCHEMA`);
  const used = FINANCE_PANEL.widgets.map((w) => w.config.alertLimit && w.config.alertLimit.settingKey).filter(Boolean).sort();
  assert.deepEqual(used, Object.keys(PANEL_SETTINGS_SCHEMA).sort(), 'parâmetro declarado que nada lê é defeito');
});

test('m9d626 o painel só mostra o que a API devolve: a busca por soma e divisão no código do Front não acha nada', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: path.join(__dirname, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
});
