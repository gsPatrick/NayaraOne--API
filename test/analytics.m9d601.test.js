'use strict';

// M9-D601 — dashboard_definitions, dashboard_widgets, executive_briefs e export_jobs (schema analytics) com RLS.
// Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d601.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const metrics = require('../src/features/analytics/metricStore.service');
const dashboards = require('../src/features/analytics/dashboardStore.service');
const briefs = require('../src/features/analytics/executiveBriefStore.service');
const exportsStore = require('../src/features/analytics/exportJobStore.service');
const migration = require('../migrations/20260101009601-create-analytics-dashboards-briefs-exports');

const TABLES = ['dashboard_definitions', 'dashboard_widgets', 'executive_briefs', 'export_jobs'];
let admin;
let tenantA;
let tenantB;

before(async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js (nunca contra o banco compartilhado).');
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  tenantA = await getSeedTenant();
  const [[b]] = await admin.query(`SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = 'CI — Empresa Fictícia B' LIMIT 1`);
  const [[u]] = await admin.query(`SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'`);
  tenantB = { groupId: b.groupId, companyId: b.companyId, userId: u.id };
  assert.notEqual(tenantA.groupId, tenantB.groupId);
});

after(async () => {
  await admin.close();
  await sequelize.close();
});

async function inTx(tenant, opts, fn) {
  const { writer = false, commit = false } = opts;
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    if (writer) await metrics.enableAnalyticsWriter(transaction);
    const result = await fn(transaction);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

const ctxOf = (t) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId });
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const sfx = () => `${uniqueSuffix()}${Math.floor(Math.random() * 1000)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

// Roda dentro de um SAVEPOINT: erro vindo do banco aborta a transação, e o teste segue na mesma.
async function expectCode(tx, fn, status, code) {
  await sequelize.query('SAVEPOINT exp', { transaction: tx });
  try {
    await assert.rejects(fn(), (err) => {
      assert.equal(err.statusCode, status, `status ${err.statusCode} ${err.message}`);
      assert.equal(err.code, code);
      return true;
    });
  } finally {
    await sequelize.query('ROLLBACK TO SAVEPOINT exp', { transaction: tx });
  }
}

async function publishedMetric(tx, tenant, metricCode) {
  const def = await metrics.createMetricDefinition(
    { scopeLevel: 'COMPANY', groupId: tenant.groupId, companyId: tenant.companyId, metricCode, name: 'Caixa', domain: 'FINANCE' }, ctxOf(tenant), tx);
  await metrics.publishMetricVersion({
    definitionId: def.id, expectedVersion: 0, formulaId: 'x.v1', formulaSemantic: 'Soma.', unit: 'BRL', valueNature: 'ACTUAL',
    refreshPolicy: { mode: 'EVENT' }, validFrom: '2026-01-01',
  }, ctxOf(tenant), tx);
  return def;
}

const dashInput = (tenant, extra = {}) => ({
  scopeLevel: 'COMPANY', groupId: tenant.groupId, companyId: tenant.companyId, dashboardCode: `fin_${sfx()}`,
  name: 'Financeiro', domain: 'FINANCE', audienceRoles: ['DIRETORIA'], requiredPermission: 'analytics:read', p95TargetMs: 1500, ...extra,
});

const briefInput = (tenant, extra = {}) => ({
  groupId: tenant.groupId, companyId: tenant.companyId, briefType: 'DAILY', periodStart: '2026-10-27', periodEnd: '2026-10-27',
  status: 'GENERATED', content: [{ ordem: 1, tipo: 'DESTAQUE', fato: 'Caixa subiu' }],
  sourceRefs: [{ metricCode: 'fin.caixa', version: 1 }], freshnessSummary: { fin: 'FRESH' }, qualitySummary: {}, ...extra,
});

const exportInput = (tenant, extra = {}) => ({
  groupId: tenant.groupId, companyId: tenant.companyId, requestedBy: tenant.userId, dashboardCode: 'financeiro',
  scope: { companyId: tenant.companyId }, filters: { period: '2026-10', status: 'OPEN' }, riskLevel: 'LOW', ...extra,
});

// ------------------------------------------------------------------ 1
test('m9d601 widget com métrica inexistente é recusado', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await dashboards.createDashboardDefinition(dashInput(tenantA), ctxOf(tenantA), tx);
    await dashboards.addDashboardWidget(d.id, { widgetType: 'KPI_CARD', metricCode: 'fin.inexistente', title: 'Caixa', position: 1 }, ctxOf(tenantA), tx);
    await expectCode(tx, () => dashboards.publishDashboard(d.id, ctxOf(tenantA), tx), 422, 'ANALYTICS_DASHBOARD_INVALID_METRIC');
  });
  // métrica existente mas só DRAFT também não vale
  await inTx(tenantA, { writer: true }, async (tx) => {
    const code = `fin.rascunho_${sfx()}`;
    await metrics.createMetricDefinition({ scopeLevel: 'COMPANY', groupId: tenantA.groupId, companyId: tenantA.companyId, metricCode: code, name: 'R', domain: 'FINANCE' }, ctxOf(tenantA), tx);
    const d = await dashboards.createDashboardDefinition(dashInput(tenantA), ctxOf(tenantA), tx);
    await dashboards.addDashboardWidget(d.id, { widgetType: 'TREND', metricCode: code, title: 'T', position: 1 }, ctxOf(tenantA), tx);
    await expectCode(tx, () => dashboards.publishDashboard(d.id, ctxOf(tenantA), tx), 422, 'ANALYTICS_DASHBOARD_INVALID_METRIC');
  });
});

test('m9d601 painel publicado lista widgets na ordem de position e fica imutável; v2 retira a v1', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const code = `fin.caixa_${sfx()}`;
    await publishedMetric(tx, tenantA, code);
    const input = dashInput(tenantA);
    const d = await dashboards.createDashboardDefinition(input, ctxOf(tenantA), tx);
    assert.equal(d.version, 1);
    await dashboards.addDashboardWidget(d.id, { widgetType: 'BAR', metricCode: code, title: 'B', position: 3 }, ctxOf(tenantA), tx);
    await dashboards.addDashboardWidget(d.id, { widgetType: 'KPI_CARD', metricCode: code, title: 'K', position: 1 }, ctxOf(tenantA), tx);
    await dashboards.addDashboardWidget(d.id, { widgetType: 'QUALITY_BANNER', title: 'Q', position: 0 }, ctxOf(tenantA), tx);
    const pub = await dashboards.publishDashboard(d.id, ctxOf(tenantA), tx);
    assert.equal(pub.status, 'PUBLISHED');
    const full = await dashboards.getDashboardWithWidgets(d.id, tx);
    assert.deepEqual(full.widgets.map((w) => w.position), [0, 1, 3]); // M9-D687: a faixa de qualidade é o primeiro widget
    await expectCode(tx, () => dashboards.addDashboardWidget(d.id, { widgetType: 'QUALITY_BANNER', title: 'X', position: 9 }, ctxOf(tenantA), tx), 409, 'ANALYTICS_DASHBOARD_PUBLISHED_IMMUTABLE');
    const v2 = await dashboards.createDashboardDefinition({ ...input, baseDashboardId: d.id }, ctxOf(tenantA), tx);
    assert.equal(v2.version, 2);
    assert.equal(v2.status, 'DRAFT');
    const copy = await dashboards.getDashboardWithWidgets(v2.id, tx);
    assert.equal(copy.widgets.length, 3, 'a nova versão parte dos widgets da anterior');
    await dashboards.publishDashboard(v2.id, ctxOf(tenantA), tx);
    const [[old]] = await sequelize.query('SELECT status FROM analytics.dashboard_definitions WHERE id = :id', { replacements: { id: d.id }, transaction: tx });
    assert.equal(old.status, 'RETIRED');
    const [[aud]] = await sequelize.query(`SELECT action FROM audit.audit_log WHERE entity_type = 'analytics.dashboard' AND entity_id = :id`, { replacements: { id: v2.id }, transaction: tx });
    assert.equal(aud.action, 'analytics.dashboard.publish');
  });
});

// ------------------------------------------------------------------ 2
test('m9d601 widget com chave sql/formula/expression é recusado', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const d = await dashboards.createDashboardDefinition(dashInput(tenantA), ctxOf(tenantA), tx);
    for (const config of [{ sql: 'select 1' }, { opcoes: { Formula: 'a+b' } }, { lista: [{ x: { EXPRESSION: '1' } }] }]) {
      await expectCode(tx, () => dashboards.addDashboardWidget(d.id, { widgetType: 'KPI_CARD', metricCode: 'fin.caixa', title: 'K', position: 1, config }, ctxOf(tenantA), tx), 422, 'ANALYTICS_WIDGET_FORMULA_FORBIDDEN');
    }
    const ok = await dashboards.addDashboardWidget(d.id, { widgetType: 'KPI_CARD', metricCode: 'fin.caixa', title: 'K', position: 1, config: { cor: 'verde', sqlite: true } }, ctxOf(tenantA), tx);
    assert.ok(ok.id, 'chaves parecidas mas diferentes passam');
  });
  // banco: mesmo fora do serviço (superusuário, sem RLS) o gatilho recusa, em qualquer profundidade
  const t = await admin.transaction();
  try {
    const [[d]] = await admin.query(
      `INSERT INTO analytics.dashboard_definitions (company_id, group_id, dashboard_code, name, domain, required_permission)
       VALUES (:c, :g, :code, 'P', 'FINANCE', 'analytics:read') RETURNING id`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId, code: `raw_${sfx()}` }, transaction: t });
    await admin.query('SAVEPOINT s1', { transaction: t });
    await assert.rejects(admin.query(
      `INSERT INTO analytics.dashboard_widgets (company_id, group_id, dashboard_id, position, widget_type, metric_code, title, config)
       VALUES (:c, :g, :d, 1, 'KPI_CARD', 'fin.caixa', 'K', '{"a":[{"Sql":"drop"}]}')`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId, d: d.id }, transaction: t }), (e) => e.original?.code === 'ANA08');
  } finally { await t.rollback(); }
});

// ------------------------------------------------------------------ 3
test('m9d601 filtros de export não mudam depois de enfileirado', async () => {
  await inTx(tenantA, {}, async (tx) => {
    const job = await exportsStore.createExportJob(exportInput(tenantA), ctxOf(tenantA), tx);
    assert.equal(job.status, 'QUEUED');
    assert.deepEqual(job.filters, { period: '2026-10', status: 'OPEN' });
    await expectCode(tx, () => exportsStore.updateExportJobState(job.id, { filters: { period: '2025-01' } }, tx), 409, 'ANALYTICS_EXPORT_SCOPE_FROZEN');
    await expectCode(tx, () => exportsStore.updateExportJobState(job.id, { scope: { companyId: tenantB.companyId } }, tx), 409, 'ANALYTICS_EXPORT_SCOPE_FROZEN');
    // UPDATE cru de filters/scope/solicitante/risco é recusado pelo gatilho do banco
    await metrics.enableAnalyticsWriter(tx);
    for (const col of ["filters = '{}'::jsonb", "scope = '{}'::jsonb", 'requested_by = gen_random_uuid()', "risk_level = 'HIGH'", "metric_code = 'x.y'"]) {
      await sequelize.query('SAVEPOINT sp', { transaction: tx });
      await assert.rejects(sequelize.query(`UPDATE analytics.export_jobs SET ${col} WHERE id = :id`, { replacements: { id: job.id }, transaction: tx }), (e) => ['ANA07', '23503'].includes(e.original?.code), col);
      await sequelize.query('ROLLBACK TO SAVEPOINT sp', { transaction: tx });
    }
    const running = await exportsStore.updateExportJobState(job.id, { status: 'RUNNING' }, tx);
    assert.equal(running.status, 'RUNNING');
    assert.deepEqual(running.filters, job.filters);
    const ready = await exportsStore.updateExportJobState(job.id, { status: 'READY', rowCount: 12, fileSha256: hash('f'), expiresAt: new Date(Date.now() + 86400000) }, tx);
    assert.equal(ready.status, 'READY');
  });
});

test('m9d601 export HIGH exige mfa_step_up_id e READY exige hash, linhas e expiração', async () => {
  await inTx(tenantA, {}, async (tx) => {
    await expectCode(tx, () => exportsStore.createExportJob(exportInput(tenantA, { riskLevel: 'HIGH' }), ctxOf(tenantA), tx), 400, 'ANALYTICS_EXPORT_INVALID');
    const [[mfa]] = await sequelize.query(`SELECT gen_random_uuid() AS id`, { transaction: tx });
    const high = await exportsStore.createExportJob(exportInput(tenantA, { riskLevel: 'HIGH', mfaStepUpId: mfa.id, expiresAt: new Date(Date.now() + 3600000) }), ctxOf(tenantA), tx);
    assert.equal(high.risk_level, 'HIGH');
    assert.ok(high.expires_at, 'expiração guardada no pedido');
    await metrics.enableAnalyticsWriter(tx);
    await expectCode(tx, () => exportsStore.updateExportJobState(high.id, { status: 'READY' }, tx), 400, 'ANALYTICS_EXPORT_INVALID');
    await expectCode(tx, () => exportsStore.createExportJob(exportInput(tenantA, { requestedBy: tenantB.userId === tenantA.userId ? '00000000-0000-4000-8000-000000000001' : tenantB.userId }), ctxOf(tenantA), tx), 403, 'ANALYTICS_EXPORT_REQUESTER_MISMATCH');
  });
});

// ------------------------------------------------------------------ 4
test('m9d601 brief sem source_refs é recusado', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    for (const sourceRefs of [[], undefined, null, {}]) {
      await expectCode(tx, () => briefs.createExecutiveBrief(briefInput(tenantA, { sourceRefs }), ctxOf(tenantA), tx), 422, 'ANALYTICS_BRIEF_NO_SOURCES');
    }
    await expectCode(tx, () => briefs.createExecutiveBrief(briefInput(tenantA, { status: 'FAILED', sourceRefs: [] }), ctxOf(tenantA), tx), 422, 'ANALYTICS_BRIEF_NO_SOURCES');
    await sequelize.query('SAVEPOINT sp', { transaction: tx });
    await assert.rejects(sequelize.query(
      `INSERT INTO analytics.executive_briefs (company_id, group_id, brief_type, period_start, period_end, status, source_refs)
       VALUES (:c, :g, 'DAILY', '2026-10-01', '2026-10-01', 'GENERATED', '[]')`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId }, transaction: tx }), (e) => e.original?.code === '23514' && /sources_not_empty/.test(e.original.constraint));
    await sequelize.query('ROLLBACK TO SAVEPOINT sp', { transaction: tx });
  });
});

test('m9d601 brief guarda fontes e freshness, regenerar torna o anterior SUPERSEDED e o conteúdo é imutável', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    const b1 = await briefs.createExecutiveBrief(briefInput(tenantA), ctxOf(tenantA), tx);
    assert.deepEqual(b1.freshness_summary, { fin: 'FRESH' });
    assert.equal(b1.source_refs.length, 1);
    await sequelize.query('SAVEPOINT sp', { transaction: tx });
    await assert.rejects(sequelize.query(
      `INSERT INTO analytics.executive_briefs (company_id, group_id, brief_type, period_start, period_end, status, source_refs)
       VALUES (:c, :g, 'DAILY', '2026-10-27', '2026-10-27', 'GENERATED', '[{"a":1}]')`,
      { replacements: { c: tenantA.companyId, g: tenantA.groupId }, transaction: tx }), (e) => e.original?.code === '23505');
    await sequelize.query('ROLLBACK TO SAVEPOINT sp', { transaction: tx });
    await expectCode(tx, () => briefs.createExecutiveBrief(briefInput(tenantA), ctxOf(tenantA), tx), 409, 'ANALYTICS_BRIEF_ALREADY_CURRENT');
    const b2 = await briefs.createExecutiveBrief(briefInput(tenantA, { supersede: true, content: [{ ordem: 1, fato: 'novo' }] }), ctxOf(tenantA), tx);
    const [[old]] = await sequelize.query('SELECT status FROM analytics.executive_briefs WHERE id = :id', { replacements: { id: b1.id }, transaction: tx });
    assert.equal(old.status, 'SUPERSEDED');
    assert.equal(b2.status, 'GENERATED');
    await sequelize.query('SAVEPOINT sp2', { transaction: tx });
    await assert.rejects(sequelize.query(`UPDATE analytics.executive_briefs SET content = '[]' WHERE id = :id`, { replacements: { id: b2.id }, transaction: tx }), (e) => e.original?.code === 'ANA10');
    await sequelize.query('ROLLBACK TO SAVEPOINT sp2', { transaction: tx });
  });
});

// ------------------------------------------------------------------ 5
test('m9d601 RLS entre empresas nas 4 tabelas', async () => {
  const ids = await inTx(tenantA, { writer: true, commit: true }, async (tx) => {
    const d = await dashboards.createDashboardDefinition(dashInput(tenantA), ctxOf(tenantA), tx);
    const w = await dashboards.addDashboardWidget(d.id, { widgetType: 'QUALITY_BANNER', title: 'Q', position: 1 }, ctxOf(tenantA), tx);
    const b = await briefs.createExecutiveBrief(briefInput(tenantA, { periodStart: '2026-09-01', periodEnd: '2026-09-01' }), ctxOf(tenantA), tx);
    const e = await exportsStore.createExportJob(exportInput(tenantA), ctxOf(tenantA), tx);
    return { dashboard_definitions: d.id, dashboard_widgets: w.id, executive_briefs: b.id, export_jobs: e.id };
  });
  try {
    await inTx(tenantB, { writer: true }, async (tx) => {
      for (const table of TABLES) {
        const [rows] = await sequelize.query(`SELECT id FROM analytics.${table} WHERE id = :id`, { replacements: { id: ids[table] }, transaction: tx });
        assert.equal(rows.length, 0, `${table}: empresa B não lê a linha da A`);
        const [, meta] = await sequelize.query(`UPDATE analytics.${table} SET updated_at = now() WHERE id = :id`, { replacements: { id: ids[table] }, transaction: tx });
        assert.equal(meta.rowCount, 0, `${table}: empresa B não altera a linha da A`);
      }
      await expectCode(tx, () => exportsStore.createExportJob(exportInput(tenantA, { requestedBy: tenantB.userId }), ctxOf(tenantB), tx), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
    });
    await inTx(tenantA, {}, async (tx) => {
      for (const table of TABLES) {
        const [rows] = await sequelize.query(`SELECT id FROM analytics.${table} WHERE id = :id`, { replacements: { id: ids[table] }, transaction: tx });
        assert.equal(rows.length, 1, `${table}: a dona lê`);
      }
      // sem a GUC do worker: dashboards e briefs são só do worker (403); export_jobs só no nome de quem pede
      await expectCode(tx, () => briefs.createExecutiveBrief(briefInput(tenantA, { periodStart: '2026-08-01', periodEnd: '2026-08-01' }), ctxOf(tenantA), tx), 403, 'ANALYTICS_WRITE_FORBIDDEN');
      await expectCode(tx, () => dashboards.createDashboardDefinition(dashInput(tenantA), ctxOf(tenantA), tx), 403, 'ANALYTICS_WRITE_FORBIDDEN');
    });
    await inTx(tenantA, {}, async (tx) => {
      await sequelize.query('SAVEPOINT sp', { transaction: tx });
      await assert.rejects(sequelize.query(
        `INSERT INTO analytics.export_jobs (company_id, group_id, requested_by, dashboard_code, scope, risk_level)
         VALUES (:c, :g, gen_random_uuid(), 'x', '{}', 'LOW')`,
        { replacements: { c: tenantA.companyId, g: tenantA.groupId }, transaction: tx }), (e) => ['42501', '23503'].includes(e.original?.code));
    });
  } finally {
    await admin.query(`DELETE FROM analytics.export_jobs WHERE id = :e; DELETE FROM analytics.executive_briefs WHERE id = :b;
      DELETE FROM analytics.dashboard_widgets WHERE id = :w; DELETE FROM analytics.dashboard_definitions WHERE id = :d;`,
    { replacements: { e: ids.export_jobs, b: ids.executive_briefs, w: ids.dashboard_widgets, d: ids.dashboard_definitions } });
  }
});

test('m9d601 empresa de outro grupo responde 404 e widget com escopo diferente do painel é recusado', async () => {
  await inTx(tenantA, { writer: true }, async (tx) => {
    await expectCode(tx, () => dashboards.createDashboardDefinition(dashInput(tenantA, { companyId: tenantB.companyId, groupId: tenantB.groupId }), ctxOf(tenantA), tx), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
    await expectCode(tx, () => briefs.createExecutiveBrief(briefInput(tenantA, { companyId: tenantB.companyId, groupId: tenantB.groupId }), ctxOf(tenantA), tx), 404, 'ANALYTICS_SCOPE_NOT_FOUND');
    await expectCode(tx, () => dashboards.addDashboardWidget('00000000-0000-4000-8000-000000000009', { widgetType: 'QUALITY_BANNER', title: 'Q', position: 1 }, ctxOf(tenantA), tx), 404, 'ANALYTICS_DASHBOARD_NOT_FOUND');
  });
});

// ------------------------------------------------------------------ 6
test('m9d601 migration idempotente com down', async () => {
  const qi = { sequelize: { query: (sql) => admin.query(sql, { transaction: qi.tx }) } };
  const t = await admin.transaction();
  qi.tx = t;
  try {
    await migration.up(qi);
    await migration.up(qi);
    await migration.down(qi);
    const [gone] = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name IN (${TABLES.map((x) => `'${x}'`).join(',')})`, { transaction: t });
    assert.equal(gone[0].n, 0, 'down remove as 4 tabelas');
    const [[core]] = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name = 'metric_definitions'`, { transaction: t });
    assert.equal(core.n, 1, 'o down não toca nas tabelas da D600');
    await migration.up(qi);
    const [tabs] = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS pol
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (${TABLES.map((x) => `'${x}'`).join(',')})`, { transaction: t });
    assert.equal(tabs.length, 4);
    for (const r of tabs) { assert.ok(r.relrowsecurity && r.relforcerowsecurity && r.pol === 4, `${r.relname} RLS/FORCE/4 políticas`); }
  } finally { await t.rollback(); }
});

test('m9d601 GRANTs só para nayara_runtime e nada para PUBLIC', async () => {
  const [rows] = await admin.query(
    `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'analytics' AND table_name IN (${TABLES.map((x) => `'${x}'`).join(',')})`);
  assert.ok(!rows.some((r) => r.grantee === 'PUBLIC'));
  for (const table of TABLES) {
    const privs = rows.filter((r) => r.table_name === table && r.grantee === 'nayara_runtime').map((r) => r.privilege_type);
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.ok(privs.includes(p), `${table} ${p}`);
  }
});
