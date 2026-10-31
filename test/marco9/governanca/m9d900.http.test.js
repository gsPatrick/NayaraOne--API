'use strict';

// M9-D900 — POST /migration/runs pela API real: 202 com runId, execução em segundo plano, 403 sem permissão, 422 para fonte desconhecida e isolamento. Banco descartável.
// Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D900_HTTP_TEST_PORT || '21900';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

const PERMISSION = 'governance:migration:run';
const ROLES = { gestor: 'CI GESTOR', leitura: 'CI LEITURA' };
let baseUrl; let tenants; let appLoaded = false; let httpSkip = null;
const tokens = {};

async function setPermission(role, granted) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = $2', [role, PERMISSION]);
  if (granted) {
    await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = $2`, [role, PERMISSION]);
  }
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  await setPermission(ROLES.gestor, true);
  await setPermission(ROLES.leitura, false);
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
  if (DISPOSABLE && tenants) await setPermission(ROLES.gestor, false);
  if (DISPOSABLE && tenants) await require('../_helpers/m9d900Clean').cleanMigration();
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const waitRun = async (runId) => {
  for (let i = 0; i < 400; i += 1) { // até 60 s: a execução sem filtro percorre todas as fontes da empresa, que se acumulam no banco descartável
     
    const [row] = (await adminQuery('SELECT status, summary FROM governance.mig_runs WHERE id = $1', [runId])).rows;
    if (row && ['SUCCEEDED', 'FAILED'].includes(row.status)) return row;
     
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('a execução não terminou');
};

test('m9d900 POST /migration/runs responde 202 com runId', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const legacy = await env.installSource(tenants.A, { mode: 'CDC' });
  for (let i = 1; i <= 5; i += 1) legacy.fake.event(`${i}`, 'I', i, env.personRecord());
  const res = await call('gestor', 'POST', '/migration/runs', { sourceSystem: legacy.system });
  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);
  assert.match(res.body.data.runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(res.body.data), ['runId']);
  const done = await waitRun(res.body.data.runId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal((await env.recordsOf(legacy.system)).filter((r) => ['MIGRATED', 'RECONCILED'].includes(r.state)).length, 5, 'os lotes foram aplicados em segundo plano (a verificação da M9-D905 pode já ter reconciliado)');
  assert.equal((await env.batchesOf(legacy.system))[0].run_id, res.body.data.runId);
  const [audit] = (await adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = $1 AND action IN ('migration.run.queued', 'migration.run.finished')", [res.body.data.runId])).rows;
  assert.equal(audit.n, 2, 'a execução é auditada ao entrar e ao sair');
  legacy.dispose();
});

test('m9d900 sem a permissão governance:migration:run a rota responde 403', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const res = await call('leitura', 'POST', '/migration/runs', {});
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  assert.equal(res.body.error.message, 'Permissão ausente: governance:migration:run.');
  assert.ok(res.body.error.traceId, 'envelope de erro de governança');
  const before = (await adminQuery('SELECT count(*)::int AS n FROM governance.mig_runs')).rows[0].n;
  assert.equal((await adminQuery('SELECT count(*)::int AS n FROM governance.mig_runs')).rows[0].n, before);
});

test('m9d900 fonte desconhecida ou entidade inválida devolvem 422 sem criar execução', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const count = async () => (await adminQuery('SELECT count(*)::int AS n FROM governance.mig_runs')).rows[0].n;
  const before = await count();
  const unknown = await call('gestor', 'POST', '/migration/runs', { sourceSystem: 'NAO_EXISTE' });
  assert.deepEqual([unknown.status, unknown.body.error.code], [422, 'GOV_MIG_RUN_INVALID']);
  const entity = await call('gestor', 'POST', '/migration/runs', { entity: 'ALIEN' });
  assert.deepEqual([entity.status, entity.body.error.code], [422, 'GOV_MIG_RUN_INVALID']);
  assert.equal(await count(), before);
});

test('m9d900 corpo omitido inicia todas as fontes semeadas da empresa', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const res = await call('gestor', 'POST', '/migration/runs', {});
  assert.equal(res.status, 202);
  const seeded = (await adminQuery("SELECT entity FROM governance.mig_sources WHERE company_id = $1 AND source_system = 'LEGADO_ERP' ORDER BY entity", [tenants.A.companyId])).rows.map((r) => r.entity);
  assert.deepEqual(seeded, ['PERSON', 'PROPERTY', 'SUPPLIER']);
  const done = await waitRun(res.body.data.runId);
  assert.equal(done.status, 'FAILED', 'sem a credencial do legado no ambiente, o conector SQL para a fonte com erro claro');
  const legado = done.summary.sources.filter((s) => s.source === 'LEGADO_ERP');
  assert.equal(legado.length, 3);
  assert.ok(legado.every((s) => s.error.code === 'GOV_MIG_SECRET_MISSING'));
});
