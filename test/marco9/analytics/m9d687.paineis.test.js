'use strict';

// M9-D687 — catálogo dos 12 painéis, publicação, versionamento e visibilidade por permissão. Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/analytics/m9d687.paineis.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const dashboards = require('../../../src/features/analytics/dashboardStore.service');
const catalog = require('../../../src/features/analytics/dashboards/dashboard.catalog');
const migration = require('../../../migrations/20260101009687-seed-analytics-dashboard-catalog');

const { inTx, ctxOf, panelBody, BANNER, ALERTS, sequelize } = sup;
const ADMIN = ['analytics:read', 'analytics:manage'];
let env;

before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const LIVRO = ['health', 'finance', 'crm', 'rental', 'correspondent', 'construction', 'inventory', 'postwork', 'legal', 'marketing', 'support', 'tech'];

async function countGlobal() {
  const [rows] = await env.admin.query(
    `SELECT dashboard_code, status, version, p95_target_ms, required_permission FROM analytics.dashboard_definitions
      WHERE company_id IS NULL AND group_id IS NULL AND status = 'PUBLISHED' ORDER BY dashboard_code`
  );
  return rows;
}

test('m9d687 seed cria os 12 painéis e o command_center sem duplicar', async () => {
  assert.deepEqual([...catalog.DASHBOARD_CODES].sort(), [...LIVRO, 'command_center'].sort());
  const before1 = (await countGlobal()).filter((r) => catalog.DASHBOARD_CODES.includes(r.dashboard_code));
  assert.equal(before1.length, 13);
  for (const row of before1) {
    assert.equal(row.status, 'PUBLISHED', row.dashboard_code);
    assert.ok(row.version >= 1, `${row.dashboard_code}: versão vigente`); // os painéis com conteúdo (M9-D634, M9-D662...) publicam a versão seguinte
    assert.ok(row.p95_target_ms > 0, `${row.dashboard_code} sem meta p95`);
  }
  // roda a migration de novo (a lógica de up da 9687) e confere que nada duplicou
  await migration.up({ sequelize: env.admin });
  const after1 = (await countGlobal()).filter((r) => catalog.DASHBOARD_CODES.includes(r.dashboard_code));
  assert.equal(after1.length, 13, 'o seed duplicou painéis');
  const [widgets] = await env.admin.query(
    `SELECT d.dashboard_code, w.position, w.widget_type FROM analytics.dashboard_widgets w JOIN analytics.dashboard_definitions d ON d.id = w.dashboard_id
      WHERE d.company_id IS NULL AND d.group_id IS NULL AND d.status = 'PUBLISHED' AND d.dashboard_code IN (:codes) AND w.position = 0`,
    { replacements: { codes: catalog.DASHBOARD_CODES } }
  );
  assert.equal(widgets.length, 13);
  assert.ok(widgets.every((w) => w.widget_type === 'QUALITY_BANNER'), 'o primeiro widget de todo painel é a faixa de qualidade');
  const [[row]] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.dashboard_widgets w JOIN analytics.dashboard_definitions d ON d.id = w.dashboard_id WHERE d.dashboard_code = 'command_center' AND d.status = 'PUBLISHED' AND w.widget_type = 'BRIEF'"); // só a versão vigente (a 2, da M9-D685, mantém o BRIEF)
  assert.equal(row.n, 1);
});

test('m9d687 painéis do catálogo apontam para permissão que existe', async () => {
  const [perms] = await env.admin.query('SELECT code FROM core.permissions');
  const known = new Set(perms.map((p) => p.code));
  for (const p of catalog.DASHBOARD_CATALOG) assert.ok(known.has(p.requiredPermission), `${p.code}: permissão ${p.requiredPermission} inexistente`);
});

test('m9d687 publicação recusa métrica inexistente', async () => {
  const res = await env.call('POST', '/analytics/dashboards', {
    perms: ADMIN, body: panelBody({ widgets: [BANNER, { widgetType: 'KPI_CARD', title: 'Caixa', metricCode: 'fin.nao_existe_687' }] }),
  });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'ANALYTICS_DASHBOARD_INVALID_METRIC');
  assert.equal(res.body.error.message, 'O painel referencia um indicador que não está publicado.');
});

test('m9d687 publicação recusa widget com fórmula', async () => {
  for (const config of [{ formula: 'a+b' }, { nested: { SQL: 'select 1' } }]) {
    const res = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ widgets: [BANNER, { ...ALERTS, config }] }) });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'ANALYTICS_WIDGET_FORMULA_FORBIDDEN');
  }
});

test('m9d687 publicação exige faixa de qualidade como primeiro widget', async () => {
  for (const widgets of [[ALERTS, BANNER], [ALERTS]]) {
    const res = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ widgets }) });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'ANALYTICS_DASHBOARD_NO_QUALITY_BANNER');
    assert.equal(res.body.error.message, 'O primeiro bloco do painel deve ser a faixa de qualidade.');
  }
});

test('m9d687 publicação exige meta p95 e permissão existente (serviço)', async () => {
  await inTx(env.tenantA, { writer: true }, async (tx) => {
    const ctx = ctxOf(env.tenantA);
    const base = { scopeLevel: 'COMPANY', groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, name: 'X', domain: 'FINANCE' };
    const semP95 = await dashboards.createDashboardDefinition({ ...base, dashboardCode: `m9d687_${sup.sfx()}`, requiredPermission: 'finance:read' }, ctx, tx);
    await dashboards.addDashboardWidget(semP95.id, { ...BANNER, position: 0 }, ctx, tx);
    await assert.rejects(dashboards.publishDashboard(semP95.id, ctx, tx), (e) => e.statusCode === 422 && e.code === 'ANALYTICS_DASHBOARD_NO_P95');
    const semPerm = await dashboards.createDashboardDefinition({ ...base, dashboardCode: `m9d687_${sup.sfx()}`, requiredPermission: 'nao:existe', p95TargetMs: 1500 }, ctx, tx);
    await dashboards.addDashboardWidget(semPerm.id, { ...BANNER, position: 0 }, ctx, tx);
    await assert.rejects(dashboards.publishDashboard(semPerm.id, ctx, tx), (e) => e.statusCode === 422 && e.code === 'ANALYTICS_DASHBOARD_PERMISSION_UNKNOWN');
  });
});

test('m9d687 painel fora do papel devolve 403 e painel inexistente devolve 404', async () => {
  const semLeitura = await env.call('GET', '/analytics/dashboards/finance', { perms: ['finance:read'] });
  assert.equal(semLeitura.status, 403);
  assert.equal(semLeitura.body.error.code, 'PERMISSION_DENIED');
  assert.equal(semLeitura.body.error.details.permission, 'analytics:read');

  const foraDoPapel = await env.call('GET', '/analytics/dashboards/finance', { perms: ['analytics:read', 'legal:read'] });
  assert.equal(foraDoPapel.status, 403);
  assert.equal(foraDoPapel.body.error.code, 'PERMISSION_DENIED');
  assert.equal(foraDoPapel.body.error.details.permission, 'finance:read');
  assert.equal(foraDoPapel.body.error.message, 'Permissão ausente: finance:read.');

  const ok = await env.call('GET', '/analytics/dashboards/finance', { perms: ['analytics:read', 'finance:read'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.dashboardCode, 'finance');
  assert.equal(ok.body.data.widgets[0].type, 'QUALITY_BANNER');
  assert.equal(ok.body.data.requiredPermission, 'finance:read');

  const inexistente = await env.call('GET', '/analytics/dashboards/xyz', { perms: ['analytics:read', 'finance:read'] });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.body.error.code, 'ANALYTICS_DASHBOARD_NOT_FOUND');
  const formato = await env.call('GET', '/analytics/dashboards/X-Y;drop', { perms: ['analytics:read'] });
  assert.equal(formato.status, 404);
});

test('m9d687 painel despublicado devolve 404 e painel de outra empresa não aparece', async () => {
  const body = panelBody();
  const pub = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  const perms = ['analytics:read', 'finance:read'];
  assert.equal((await env.call('GET', `/analytics/dashboards/${body.dashboardCode}`, { perms })).status, 200);
  assert.equal((await env.call('GET', `/analytics/dashboards/${body.dashboardCode}`, { perms, tenant: 'B' })).status, 404, 'empresa B não vê o painel da A');
  await env.admin.query("UPDATE analytics.dashboard_definitions SET status = 'RETIRED' WHERE dashboard_code = :c", { replacements: { c: body.dashboardCode } });
  const res = await env.call('GET', `/analytics/dashboards/${body.dashboardCode}`, { perms });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ANALYTICS_DASHBOARD_NOT_FOUND');
});

test('m9d687 nova versão de painel fecha a anterior e a auditoria traz a diferença de widgets', async () => {
  const body = panelBody();
  const v1 = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  assert.equal(v1.body.data.version, 1);
  const v2 = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: { ...body, widgets: [BANNER, ALERTS, { widgetType: 'LIST_ALERTS', title: 'Mais alertas' }] } });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.data.version, 2);
  const [rows] = await env.admin.query('SELECT version, status FROM analytics.dashboard_definitions WHERE dashboard_code = :c ORDER BY version', { replacements: { c: body.dashboardCode } });
  assert.deepEqual(rows, [{ version: 1, status: 'RETIRED' }, { version: 2, status: 'PUBLISHED' }]);
  const [[aud]] = await env.admin.query(
    `SELECT after_json FROM audit.audit_log WHERE action = 'analytics.dashboard.publish' AND after_json->>'dashboardCode' = :c AND (after_json->>'versao')::int = 2`,
    { replacements: { c: body.dashboardCode } }
  );
  assert.equal(aud.after_json.diferencaWidgets.added.length, 1);
  assert.equal(aud.after_json.diferencaWidgets.added[0].title, 'Mais alertas');
});

test('m9d687 publicar exige analytics:manage, escopo de empresa ou grupo e a meta p95 informada', async () => {
  const semManage = await env.call('POST', '/analytics/dashboards', { perms: ['analytics:read'], body: panelBody() });
  assert.equal(semManage.status, 403);
  assert.equal(semManage.body.error.details.required, 'analytics:manage');
  const global = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ scopeLevel: 'GLOBAL' }) });
  assert.equal(global.status, 400);
  const semWidgets = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ widgets: [] }) });
  assert.equal(semWidgets.status, 400);
  const ok = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody() });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.p95TargetMs, 1500, 'vale a meta informada (a M9-D698 não aceita publicar sem ela)');
  const grupo = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body: panelBody({ scopeLevel: 'GROUP' }) });
  assert.equal(grupo.status, 403, 'painel de grupo exige analytics:read:group');
  await sequelize.query('SELECT 1');
});

test('m9d687 painel com widget de métrica PUBLICADA publica e a retirada da métrica fica bloqueada enquanto o painel a usa', async () => {
  const registry = require('../../../src/features/analytics/metrics');
  const { metricCode, cleanup } = await sup.publishTestMetric(env);
  try {
    const body = panelBody({ widgets: [BANNER, { widgetType: 'KPI_CARD', title: 'Caixa livre', metricCode }] });
    const res = await env.call('POST', '/analytics/dashboards', { perms: ADMIN, body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.widgets[1].metricCode, metricCode);
    await inTx(env.tenantA, { commit: false }, async (tx) => {
      await assert.rejects(registry.retireMetric({ metricCode, scopeLevel: 'COMPANY' }, ctxOf(env.tenantA, ['analytics:manage']), tx),
        (e) => e.code === 'ANALYTICS_METRIC_IN_USE');
    });
  } finally {
    cleanup();
  }
});

test('m9d687 a rota de publicação passa a permissão do catálogo e valida o corpo', async () => {
  const res = await env.call('POST', '/analytics/dashboards', { perms: ['analytics:manage'], body: {} });
  assert.equal(res.status, 400, 'com analytics:manage a rota passa a permissão e valida o corpo');
  const tabela = await env.call('GET', '/analytics/dashboards/finance', { perms: ['analytics:manage'] });
  assert.equal(tabela.status, 403, 'publicar não dá leitura');
});
