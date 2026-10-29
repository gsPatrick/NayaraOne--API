'use strict';

// M9-D698 (3.5) — meta p95 por painel: única fonte é dashboard_definitions.p95_target_ms; todo painel do catálogo tem a meta do livro e a
// publicação sem meta é recusada. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const dashboardStore = require('../../../src/features/analytics/dashboardStore.service');
const catalog = require('../../../src/features/analytics/dashboards/dashboard.catalog');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { inTx, ctxOf, panelBody, BANNER, sequelize } = sup;
const ADMIN = ['analytics:read', 'analytics:manage'];
let env;
before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const BOOK = {
  finance: 1500, crm: 1500, rental: 1500, marketing: 1500, support: 1500,
  construction: 1800, inventory: 1800, postwork: 1800, legal: 1800, correspondent: 1800,
  tech: 1400, command_center: 2500, health: 2500,
};

test('m9d698 todo painel do catálogo tem a meta p95 do livro, no catálogo e no banco', async () => {
  assert.deepEqual(Object.keys(BOOK).sort(), [...catalog.DASHBOARD_CODES].sort());
  for (const panel of catalog.DASHBOARD_CATALOG) assert.equal(panel.p95TargetMs, BOOK[panel.code], `${panel.code} no catálogo`);
  const [rows] = await env.admin.query(
    'SELECT dashboard_code, p95_target_ms FROM analytics.dashboard_definitions WHERE company_id IS NULL AND group_id IS NULL AND status = \'PUBLISHED\' AND dashboard_code IN (:codes)',
    { replacements: { codes: catalog.DASHBOARD_CODES } }
  );
  assert.equal(rows.length, 13);
  for (const r of rows) assert.equal(r.p95_target_ms, BOOK[r.dashboard_code], `${r.dashboard_code} no banco`);
});

test('m9d698 publicação sem meta p95 é recusada', async () => {
  const semBody = panelBody({ p95TargetMs: undefined });
  const http = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: semBody });
  assert.equal(http.status, 422, JSON.stringify(http.body));
  assert.equal(http.body.error.code, 'ANALYTICS_DASHBOARD_NO_P95');
  assert.equal(http.body.error.message, 'Defina a meta de tempo (p95) do painel.');
  const [[n]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.dashboard_definitions WHERE dashboard_code = :c', { replacements: { c: semBody.dashboardCode } });
  assert.equal(n.n, 0, 'nada foi gravado');

  const ok = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ p95TargetMs: 1500 }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.p95TargetMs, 1500);

  const invalid = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ p95TargetMs: 0 }) });
  assert.ok([400, 422].includes(invalid.status), `meta zero: ${invalid.status}`);

  await inTx(env.tenantA, { commit: false, writer: true }, async (tx) => {
    const ctx = ctxOf(env.tenantA, ADMIN);
    const base = { scopeLevel: 'COMPANY', groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, name: 'Sem meta', description: 'd', domain: 'FINANCE', audienceRoles: [], layout: {} };
    const draft = await dashboardStore.createDashboardDefinition({ ...base, dashboardCode: `m9d698_${sup.sfx()}`, requiredPermission: 'finance:read' }, ctx, tx);
    await dashboardStore.addDashboardWidget(draft.id, { ...BANNER, position: 0 }, ctx, tx);
    await assert.rejects(dashboardStore.publishDashboard(draft.id, ctx, tx), (e) => e.statusCode === 422 && e.code === 'ANALYTICS_DASHBOARD_NO_P95');
  });
  await sequelize.query('SELECT 1');
});

test('m9d698 a meta p95 tem uma fonte só: nenhum parâmetro analytics.p95 nem p95_ms_padrao', () => {
  const keys = Object.keys(SETTINGS_SCHEMA).filter((k) => /p95/i.test(k));
  assert.deepEqual(keys, [], `parâmetros de p95 fora da coluna: ${keys.join(', ')}`);
});
