'use strict';

// M9-D903 — POST /migration/parallel/windows e GET /migration/parallel/windows/:id pela API real: janela criada (201), recusas 422 com a mensagem do livro, 403 sem permissão, relatório com o claro recalculado e blocker na Torre (GET /migration/control-tower). Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D903_HTTP_TEST_PORT || '21903';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');
const env = require('../_helpers/m9d903Env');

const ROLES = { gestor: 'CI GESTOR', leitura: 'CI LEITURA' };
const GRANTS = { 'governance:migration:run': ['gestor'] };
let baseUrl; let tenants; let appLoaded = false; let httpSkip = null;
const tokens = {};

async function setPermission(role, code, granted) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = $2', [role, code]);
  if (granted) {
    await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = $2`, [role, code]);
  }
}
const setAll = async (on) => { for (const [code, who] of Object.entries(GRANTS)) for (const profile of Object.keys(ROLES)) await setPermission(ROLES[profile], code, on && who.includes(profile)); };

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  await setAll(true);
  require('../../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const profile of Object.keys(ROLES)) {
    let res; let body;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', profile), password }) });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${profile}`);
    tokens[profile] = body.data.accessToken;
  }
});

after(async () => {
  if (DISPOSABLE && tenants) await setAll(false);
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

let scenario;
const iso = (m) => env.minutes(m).toISOString();
const body = (extra = {}) => ({ sourceSystem: scenario.system, entities: [env.ENTITY], startsAt: iso(-60), endsAt: iso(180), intervalMin: 30, rules: env.RULES, ...extra });

test('m9d903 POST /migration/parallel/windows cria a janela e recusa o que o livro manda recusar', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  scenario = await env.scenario(tenants.A);
  const ok = await call('gestor', 'POST', '/migration/parallel/windows', body({ name: 'QA-M9 janela HTTP' }));
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.data.status, ok.body.data.intervalMin, ok.body.data.entities], ['SCHEDULED', 30, [env.ENTITY]]);
  assert.equal(ok.body.data.rules.length, 4);
  const noRule = await call('gestor', 'POST', '/migration/parallel/windows', body({ rules: env.RULES.filter((r) => r.field !== 'name') }));
  assert.deepEqual([noRule.status, noRule.body.error.code, noRule.body.error.message], [422, 'GOV_PARALLEL_RULE_MISSING', 'Defina a regra de comparação para o campo name.']);
  const inverted = await call('gestor', 'POST', '/migration/parallel/windows', body({ startsAt: iso(60), endsAt: iso(0) }));
  assert.deepEqual([inverted.status, inverted.body.error.code, inverted.body.error.message], [422, 'GOV_PARALLEL_WINDOW_INVALID', 'O fim da janela deve ser após o início.']);
  const money = await call('gestor', 'POST', '/migration/parallel/windows', body({ rules: env.RULES.map((r) => (r.field === 'amount' ? { ...r, tolerance: 0.01 } : r)) }));
  assert.deepEqual([money.status, money.body.error.code], [422, 'GOV_PARALLEL_RULE_INVALID']);
  const noSource = await call('gestor', 'POST', '/migration/parallel/windows', body({ sourceSystem: 'NAO_EXISTE' }));
  assert.deepEqual([noSource.status, noSource.body.error.code], [422, 'GOV_PARALLEL_WINDOW_INVALID']);
  const count = (await adminQuery('SELECT count(*)::int AS n FROM governance.parallel_windows WHERE source_system = $1', [scenario.system])).rows[0].n;
  assert.equal(count, 2, 'a janela do cenário e a criada agora; as recusadas não gravaram nada');
});

test('m9d903 criar janela exige governance:migration:run', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const before = (await adminQuery('SELECT count(*)::int AS n FROM governance.parallel_windows')).rows[0].n;
  const res = await call('leitura', 'POST', '/migration/parallel/windows', body());
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [403, 'PERMISSION_DENIED', 'Permissão ausente: governance:migration:run.']);
  const read = await call('leitura', 'GET', `/migration/parallel/windows/${scenario.window.id}`);
  assert.equal(read.status, 403);
  assert.equal((await adminQuery('SELECT count(*)::int AS n FROM governance.parallel_windows')).rows[0].n, before);
});

test('m9d903 GET da janela recalcula o claro na hora e a Torre mostra o blocker pela API', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  await scenario.pair('h-1', env.GOOD_OLD, { ...env.GOOD_NEW, amount: 125001 });
  await scenario.pair('h-2', env.GOOD_OLD, env.GOOD_NEW);
  assert.equal((await env.tick(tenants.A, scenario.window.id, env.T0)).action, 'COMPLETED');
  const report = await call('gestor', 'GET', `/migration/parallel/windows/${scenario.window.id}`);
  assert.equal(report.status, 200);
  assert.deepEqual([report.body.data.status, report.body.data.openBlockers], ['RUNNING', { total: 1, shown: 1 }]);
  assert.deepEqual(report.body.data.diffs.map((d) => [d.sourceKey, d.field, d.kind, d.oldValue, d.newValue]), [['h-1', 'amount', 'VALUE', 125000, 125001]]);
  assert.deepEqual(report.body.data.runs.map((r) => [r.runNumber, r.status]), [[1, 'COMPLETED']]);
  const runId = await env.newRun(tenants.A, scenario.system, env.ENTITY);
  const tower = await call('gestor', 'GET', `/migration/control-tower?runId=${runId}`);
  assert.equal(tower.status, 200);
  const blocker = tower.body.data.blockers.find((b) => b.code === 'GOV_PARALLEL_DIFF_BLOCKER');
  assert.ok(blocker, 'o blocker da comparação aparece na Torre');
  assert.deepEqual([blocker.detail.source_key, blocker.detail.field], ['h-1', 'amount']);
  const missing = await call('gestor', 'GET', '/migration/parallel/windows/00000000-0000-4000-8000-000000000000');
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'GOV_NOT_FOUND']);
  assert.equal((await call('gestor', 'GET', '/migration/parallel/windows/abc')).status, 404);
  await adminQuery("DELETE FROM governance.parallel_windows WHERE source_system = $1", [scenario.system]);
});
