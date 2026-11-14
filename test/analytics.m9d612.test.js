'use strict';

// M9-D612 — BI-001: o dashboard é somente leitura (nenhuma rota de BI altera dado de origem).
// Roda SÓ em banco descartável (precisa do role nayara_runtime, da migration 9612 e de DATABASE_ADMIN_URL):
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d612.test.js"
// Os testes 4 e 5 (lint e Front) são estáticos e rodam em qualquer lugar.

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { ESLint } = require('eslint');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant } = require('./testHelpers');
const { correlationIdMiddleware } = require('../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../src/middlewares/tenant.middleware');
const errorHandler = require('../src/middlewares/errorHandler');
const logger = require('../src/utils/logger');
const { upsertSetting, SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');

const API_ROOT = path.join(__dirname, '..');
const FRONT_ROOT = path.join(API_ROOT, '..', 'NayaraOne--FRONT');
const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const NEEDS_DB = DISPOSABLE ? false : 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca contra o banco do .env';
const ROLE_KEY = 'analytics.leitura.role_somente_leitura';

let admin;
let tenant;
let server;
let baseUrl;
let analytics;

function fakeAuth(req, res, next) {
  req.auth = { ...tenant, permissions: ['analytics:read'] };
  next();
}

async function txInfo(req) {
  return req.withTenantTransaction(async (transaction) => {
    const [[row]] = await sequelize.query('SELECT current_setting(\'transaction_read_only\') AS ro, current_user AS usr', { transaction });
    return row;
  });
}

before(async () => {
  if (!DISPOSABLE) return;
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  tenant = await getSeedTenant();
  analytics = require('../src/features/analytics');
  const router = analytics.createAnalyticsRouter({ authChain: [fakeAuth, tenantMiddleware] });
  router.get('/analytics/probe/estado', async (req, res, next) => {
    try { res.json({ data: await txInfo(req) }); } catch (e) { next(e); }
  });
  const nested = express.Router();
  nested.get('/:id', async (req, res, next) => {
    try { res.json({ data: await txInfo(req) }); } catch (e) { next(e); }
  });
  router.use('/analytics/probe/aninhado', nested);
  router.get('/analytics/probe/escrita-finance', async (req, res, next) => {
    try {
      await req.withTenantTransaction((transaction) => sequelize.query(
        'INSERT INTO finance.financial_entries (id) VALUES (gen_random_uuid())', { transaction }
      ));
      res.json({ data: 'gravou' });
    } catch (e) { next(e); }
  });
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use('/v1', router);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  server.router = router;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin) await admin.close();
  await sequelize.close();
});

async function call(method, url) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: ['GET', 'HEAD'].includes(method) ? undefined : '{"value":1}' });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

async function setRoleSetting(value) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    await upsertSetting(ROLE_KEY, value, tenant, tenant.userId, transaction);
  });
  analytics.resetReaderRoleProbe();
}

test('m9d612 BI-001 todo GET de analytics roda em transação READ ONLY', { skip: NEEDS_DB }, async () => {
  const routes = analytics.listAnalyticsRoutes(server.router);
  const gets = routes.filter((r) => r.method === 'GET');
  assert.ok(gets.length >= 3, 'a varredura precisa enxergar as rotas GET (inclusive a do roteador aninhado)');
  console.log('[varredura] rotas /analytics registradas:\n' + routes.map((r) => `  ${r.method} ${r.path} (guarda antes: ${r.guarded})`).join('\n'));
  for (const route of routes) {
    assert.ok(route.path.startsWith('/analytics'), `rota fora de /analytics: ${route.path}`);
    assert.equal(route.guarded, true, `a rota ${route.method} ${route.path} não está atrás da guarda somente leitura`);
  }
  const writes = routes.filter((r) => !['GET', 'HEAD'].includes(r.method));
  for (const w of writes) {
    assert.ok(analytics.ANALYTICS_WRITE_ROUTES.some((a) => a.method === w.method && a.path === w.path), `escrita não autorizada em /analytics: ${w.method} ${w.path}`);
  }
  for (const url of ['/analytics/probe/estado', '/analytics/probe/aninhado/abc']) {
    const res = await call('GET', url);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.ro, 'on', `${url} não rodou em transação READ ONLY`);
  }
});

test('m9d612 PATCH/PUT/DELETE em métrica responde 405', { skip: NEEDS_DB }, async () => {
  const targets = ['/analytics/metrics/fin.free_cash', '/analytics/metrics', '/analytics/dashboards/abc', '/analytics/dashboards/abc/widgets/1'];
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    for (const url of targets) {
      const res = await call(method, url);
      assert.equal(res.status, 405, `${method} ${url}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'ANALYTICS_READ_ONLY');
      assert.equal(res.body.error.message, 'Os painéis são somente leitura.');
      assert.match(res.headers.get('allow'), /GET/);
    }
  }
  const ok = await call('GET', '/analytics/probe/estado');
  assert.equal(ok.status, 200);
});

test('m9d612 escrita em finance dentro de GET de BI é recusada pelo banco', { skip: NEEDS_DB }, async (t) => {
  const spy = mock.method(logger, 'error');
  t.after(() => spy.mock.restore());
  const [[antes]] = await admin.query('SELECT count(*)::int AS n FROM finance.financial_entries');
  for (const usarRole of [true, false]) {
    await setRoleSetting(usarRole);
    const res = await call('GET', '/analytics/probe/escrita-finance');
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'ANALYTICS_WRITE_BLOCKED');
    assert.match(res.body.error.message, /somente leitura/i);
  }
  const [[depois]] = await admin.query('SELECT count(*)::int AS n FROM finance.financial_entries');
  assert.equal(depois.n, antes.n, 'nenhuma linha pode ter sido gravada');
  const incidentes = spy.mock.calls.filter((c) => c.arguments[0] && c.arguments[0].security === true && c.arguments[0].event === 'analytics.write_blocked');
  assert.equal(incidentes.length, 2, 'cada tentativa bloqueada gera log de segurança');
  assert.ok(incidentes[0].arguments[0].companyId && incidentes[0].arguments[0].correlationId);

  // O banco recusa por duas camadas independentes: transação READ ONLY (25006) e role sem privilégio (42501).
  await assert.rejects(
    sequelize.transaction(async (transaction) => {
      await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
      await sequelize.query('UPDATE finance.financial_entries SET id = id WHERE false', { transaction });
    }),
    (err) => err.parent.code === '25006'
  );
  await assert.rejects(
    sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL ROLE nayara_analytics_reader', { transaction });
      await sequelize.query('INSERT INTO finance.financial_entries (id) VALUES (gen_random_uuid())', { transaction });
    }),
    (err) => err.parent.code === '42501'
  );
});

test('m9d612 role nayara_analytics_reader lê origem e analytics e não tem escrita em nenhuma tabela', { skip: NEEDS_DB }, async () => {
  const [[role]] = await admin.query("SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nayara_analytics_reader'");
  assert.ok(role, 'role ausente');
  assert.equal(role.rolcanlogin, false);
  assert.equal(role.rolsuper || role.rolbypassrls, false);
  const [[priv]] = await admin.query(`
    SELECT count(*) FILTER (WHERE has_table_privilege('nayara_analytics_reader', c.oid, 'INSERT') OR has_table_privilege('nayara_analytics_reader', c.oid, 'UPDATE')
                              OR has_table_privilege('nayara_analytics_reader', c.oid, 'DELETE') OR has_table_privilege('nayara_analytics_reader', c.oid, 'TRUNCATE'))::int AS escrita,
           count(*) FILTER (WHERE n.nspname IN ('finance','crm','construction','legal','correspondent','inventory','analytics') AND c.relkind = 'r'
                              AND NOT has_table_privilege('nayara_analytics_reader', c.oid, 'SELECT'))::int AS sem_leitura
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')`);
  assert.equal(priv.escrita, 0);
  assert.equal(priv.sem_leitura, 0);
  await setRoleSetting(true);
  const comRole = await call('GET', '/analytics/probe/estado');
  assert.equal(comRole.body.data.usr, 'nayara_analytics_reader');
});

test('m9d612 o administrador desliga o role de leitura pela configuração (a transação continua READ ONLY)', { skip: NEEDS_DB }, async (t) => {
  assert.deepEqual(SETTINGS_SCHEMA[ROLE_KEY], { type: 'boolean' });
  t.after(async () => { await admin.query('DELETE FROM core.tenant_settings WHERE key = :k', { replacements: { k: ROLE_KEY } }); analytics.resetReaderRoleProbe(); });
  await setRoleSetting(false);
  const res = await call('GET', '/analytics/probe/estado');
  assert.equal(res.body.data.ro, 'on');
  assert.notEqual(res.body.data.usr, 'nayara_analytics_reader');
});

test('m9d612 lint proíbe import de serviço de escrita em analytics', async () => {
  const eslint = new ESLint({ cwd: API_ROOT });
  const RULE = 'nayara/analytics-somente-leitura';
  const lint = async (target, file) => {
    const dir = path.dirname(path.join(API_ROOT, file));
    const spec = target.startsWith('.') ? target : `${path.relative(dir, path.join(API_ROOT, target)).split(path.sep).join('/')}`;
    const code = `'use strict';\nrequire('${target.startsWith('.') ? target : (spec.startsWith('.') ? spec : `./${spec}`)}');\n`;
    return (await eslint.lintText(code, { filePath: path.join(API_ROOT, file) }))[0].messages;
  };
  const proibidos = [
    'src/modules/finance/application/services/financial-entry.service', 'src/features/crm/crm.service',
    'src/features/marketing/campaigns/campaign.service', 'src/features/ai/tools/x',
  ];
  for (const target of proibidos) {
    for (const file of ['src/features/analytics/dashboards/x.js', 'src/features/analytics/x.js']) {
      assert.ok((await lint(target, file)).some((m) => m.ruleId === RULE), `deveria reprovar: ${target} em ${file}`);
    }
  }
  const permitidos = [
    'src/models/index', 'src/utils/AppError', 'src/engines/audit/auditLog.service', 'src/middlewares/auth.middleware',
    'src/features/analytics/metricStore.service', 'src/features/analytics/metrics/index',
    'src/features/settings/settings.service', 'src/modules/finance/infrastructure/repositories/finance.readRepository',
  ];
  for (const target of permitidos) {
    assert.ok(!(await lint(target, 'src/features/analytics/dashboards/x.js')).some((m) => m.ruleId === RULE), `não deveria reprovar: ${target}`);
  }
  const fora = await lint('src/modules/finance/application/services/financial-entry.service', 'src/features/marketing/x.js');
  assert.ok(!fora.some((m) => m.ruleId === RULE), 'a regra vale só para o analytics');
});

test('m9d612 Front sem campo editável de valor de KPI', { skip: !fs.existsSync(path.join(FRONT_ROOT, 'app')) && 'repositório do Front ausente' }, () => {
  const { scanFrontForEditableKpi } = require('../scripts/lib/frontReadOnlyScan');
  const real = scanFrontForEditableKpi(FRONT_ROOT);
  assert.deepEqual(real.violations, [], 'tela de BI com campo editável de KPI');
  // A varredura precisa enxergar o defeito: pasta sintética com os três jeitos de editar um KPI.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d612-front-'));
  try {
    fs.mkdirSync(path.join(dir, 'app', 'painel', 'analytics'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'painel', 'analytics', 'page.js'), [
      'export default function P({ kpi }) {',
      '  return (<div><span contentEditable suppressContentEditableWarning>{kpi.value}</span>',
      '  <input value={kpi.value} onChange={() => {}} />',
      '  <Input label="Caixa livre" defaultValue={metric.valueNumeric} /></div>);',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'app', 'painel', 'analytics', 'filtro.js'), 'export const F = () => <input type="date" value={periodo} onChange={x} />;\n');
    const fake = scanFrontForEditableKpi(dir);
    assert.equal(fake.violations.length, 3);
    assert.ok(fake.violations.every((v) => v.file.endsWith('page.js')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('m9d612 migration do role é idempotente e reversível', { skip: NEEDS_DB }, async () => {
  const migration = require('../migrations/20260101009612-create-analytics-reader-role');
  const qi = admin.getQueryInterface();
  const existe = async () => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'nayara_analytics_reader'"))[0].length === 1;
  await migration.up(qi);
  await migration.up(qi);
  assert.equal(await existe(), true);
  await migration.down(qi);
  assert.equal(await existe(), false);
  await migration.down(qi);
  await migration.up(qi);
  assert.equal(await existe(), true);
  const [[m]] = await admin.query("SELECT pg_has_role('nayara_runtime', 'nayara_analytics_reader', 'USAGE') AS ok");
  assert.equal(m.ok, true);
  analytics.resetReaderRoleProbe();
});
