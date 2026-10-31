'use strict';

// M9-D901 — GET /migration/control-tower e POST /migration/records/:id/resolve pela API real: seleção por runId (404), permissão (403), motivo (400) e RACI (403). Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D901_HTTP_TEST_PORT || '21901';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');
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

test('m9d901 control-tower aceita runId e devolve 404 para inexistente', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const legacy = await env.installSource(tenants.A, { entity: 'PERSON' });
  await env.seedRecords(tenants.A, legacy.system, 'PERSON', { MIGRATED: 6, QUARANTINED: 2, PENDING: 2 });
  const runId = await env.newRun(tenants.A, legacy.system, 'PERSON');
  const res = await call('gestor', 'GET', `/migration/control-tower?runId=${runId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.run_id, runId);
  assert.deepEqual(res.body.data.totals, { total: 10, migrated: 6, reconciled: 0, quarantined: 2, pending_review: 0, excluded: 0, not_started: 2 });
  assert.ok(res.body.data.blockers.some((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN'));
  assert.ok(res.body.data.eta && 'eta_min' in res.body.data.eta);
  const latest = await call('gestor', 'GET', '/migration/control-tower');
  assert.equal(latest.status, 200, 'sem runId vale a execução mais recente');
  const unknown = await call('gestor', 'GET', `/migration/control-tower?runId=${env.randomUUID()}`);
  assert.deepEqual([unknown.status, unknown.body.error.code, unknown.body.error.message], [404, 'GOV_NOT_FOUND', 'Execução de migração não encontrada.']);
  const malformed = await call('gestor', 'GET', '/migration/control-tower?runId=nao-e-uuid');
  assert.equal(malformed.status, 404);
  legacy.dispose();
});

test('m9d901 sem a permissão governance:migration:run a Torre e a decisão respondem 403', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const tower = await call('leitura', 'GET', '/migration/control-tower');
  assert.deepEqual([tower.status, tower.body.error.code, tower.body.error.message], [403, 'PERMISSION_DENIED', 'Permissão ausente: governance:migration:run.']);
  const decision = await call('leitura', 'POST', `/migration/records/${env.randomUUID()}/resolve`, { decision: 'EXCLUDE', reason: 'x' });
  assert.equal(decision.status, 403);
});

test('m9d901 POST /migration/records/:id/resolve: motivo (400), RACI (403), decisão (200) e repetição (409)', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const legacy = await env.installSource(tenants.A, { entity: 'PERSON' });
  const rec = await env.insertRecord(tenants.A, legacy.system, 'PERSON', { key: 'h1', state: 'QUARANTINED', payload: env.personRecord({ legalName: '' }), reason: 'Nome ausente.' });
  await env.setRaci(tenants.A, env.ACTIVITY, [{ role: 'OUTRO PERFIL', raci: 'A' }, { role: 'OUTRO PERFIL', raci: 'R' }]);
  const noReason = await call('gestor', 'POST', `/migration/records/${rec.id}/resolve`, { decision: 'REPROCESS' });
  assert.deepEqual([noReason.status, noReason.body.error.code, noReason.body.error.message], [400, 'GOV_MIG_REASON_REQUIRED', 'Informe a decisão e o motivo.']);
  const forbidden = await call('gestor', 'POST', `/migration/records/${rec.id}/resolve`, { decision: 'REPROCESS', reason: 'Corrigido.' });
  assert.deepEqual([forbidden.status, forbidden.body.error.code], [403, 'GOV_MIG_RACI_FORBIDDEN']);
  await env.setRaci(tenants.A, env.ACTIVITY, [{ userId: tenants.A.userId, raci: 'A' }, { role: 'FINANCEIRO', raci: 'R' }]);
  const ok = await call('gestor', 'POST', `/migration/records/${rec.id}/resolve`, { decision: 'REPROCESS', reason: 'Corrigido na origem.' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.state, ok.body.data.previous_state], ['PENDING', 'QUARANTINED']);
  const again = await call('gestor', 'POST', `/migration/records/${rec.id}/resolve`, { decision: 'REPROCESS', reason: 'Corrigido na origem.' });
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_MIG_RECORD_INVALID_TRANSITION']);
  const unknown = await call('gestor', 'POST', `/migration/records/${env.randomUUID()}/resolve`, { decision: 'REPROCESS', reason: 'x' });
  assert.equal(unknown.status, 404);
  legacy.dispose();
});
