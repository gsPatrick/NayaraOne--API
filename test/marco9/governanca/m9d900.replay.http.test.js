'use strict';

// M9-D900 (reabertura, auditoria L7) — POST /migration/batches/:id/replay pela API real: novo lote com replay_of, mesmo root_hash, original intacto, 403 e 404. Banco descartável.
// Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D900_REPLAY_TEST_PORT || '21901';

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
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('m9d900 POST /migration/batches/:id/replay cria um novo lote com o mesmo hash e não mexe no original', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const legacy = await env.installSource(tenants.A, { mode: 'CDC' });
  for (let i = 1; i <= 4; i += 1) legacy.fake.event(`${i}`, 'I', i, env.personRecord());
  await env.run(tenants.A, { sourceSystem: legacy.system });
  const [original] = await env.batchesOf(legacy.system);
  const before = await env.recordsOf(legacy.system);
  const res = await call('gestor', 'POST', `/migration/batches/${original.id}/replay`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.replayOf, original.id);
  assert.notEqual(res.body.data.batchId, original.id);
  assert.equal(res.body.data.rootHash, original.root_hash);
  const batches = await env.batchesOf(legacy.system);
  assert.equal(batches.length, 2);
  assert.equal(batches.find((b) => b.id === original.id).status, original.status, 'o lote original não muda de estado');
  assert.equal((await env.recordsOf(legacy.system)).length, before.length, 'sem duplicar registros');
  legacy.dispose();
});

test('m9d900 replay: sem permissão 403 e lote inexistente ou id inválido 404', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const denied = await call('leitura', 'POST', '/migration/batches/00000000-0000-4000-8000-000000000000/replay');
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
  const missing = await call('gestor', 'POST', '/migration/batches/00000000-0000-4000-8000-000000000000/replay');
  assert.equal(missing.status, 404);
  const bad = await call('gestor', 'POST', '/migration/batches/nao-e-uuid/replay');
  assert.equal(bad.status, 404);
});
