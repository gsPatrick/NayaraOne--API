'use strict';

// M9-D902 — GET|PUT /migration/raci pela API real: matriz semeada, recusa do segundo A (422), 403 com a mensagem do livro e leitura separada da edição. Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D902_HTTP_TEST_PORT || '21902';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

const ROLES = { gestor: 'CI GESTOR', leitura: 'CI LEITURA' };
const GRANTS = { 'governance:migration:run': ['gestor', 'leitura'], 'governance:migration:admin': ['gestor'] };
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

test('m9d902 GET /migration/raci devolve as 10 atividades com a situação de cada uma', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const res = await call('leitura', 'GET', '/migration/raci');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.activities.length, 10);
  assert.ok(res.body.data.activities.every((a) => Array.isArray(a.entries) && typeof a.complete === 'boolean' && Array.isArray(a.missing)));
});

test('m9d902 PUT /migration/raci grava a matriz e recusa o segundo A com 422', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const me = tenants.A.userId;
  const ok = await call('gestor', 'PUT', '/migration/raci', { activity: 'ROLLBACK_EXECUTION', entries: [{ userId: me, raci: 'A' }, { role: 'TI', raci: 'R' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.activity.complete, true);
  const two = await call('gestor', 'PUT', '/migration/raci', { activity: 'ROLLBACK_EXECUTION', entries: [{ userId: me, raci: 'A' }, { role: 'GESTAO', raci: 'A' }, { role: 'TI', raci: 'R' }] });
  assert.deepEqual([two.status, two.body.error.code, two.body.error.message], [422, 'GOV_RACI_SINGLE_ACCOUNTABLE', 'Cada atividade tem exatamente uma pessoa que responde pelo resultado.']);
  assert.ok(two.body.error.traceId);
  const after = await call('gestor', 'GET', '/migration/raci');
  const row = after.body.data.activities.find((a) => a.code === 'ROLLBACK_EXECUTION');
  assert.deepEqual(row.entries.map((e) => e.raci).sort(), ['A', 'R'], 'a recusa deixou a matriz como estava');
});

test('m9d902 editar o RACI exige governance:migration:admin', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const count = async () => (await adminQuery("SELECT count(*)::int AS n FROM governance.cutover_raci WHERE company_id = $1 AND activity_code = 'GO_NO_GO'", [tenants.A.companyId])).rows[0].n;
  const before = await count();
  const res = await call('leitura', 'PUT', '/migration/raci', { activity: 'GO_NO_GO', entries: [{ role: 'QA-M9-SEM-PERMISSAO', raci: 'R' }, { role: 'QA-M9-SEM-PERMISSAO-2', raci: 'I' }] });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  assert.equal(res.body.error.message, 'Permissão ausente: governance:migration:admin.');
  assert.equal(await count(), before, 'nada foi gravado');
  assert.equal((await adminQuery("SELECT count(*)::int AS n FROM governance.cutover_raci WHERE company_id = $1 AND role LIKE 'QA-M9-SEM-PERMISSAO%'", [tenants.A.companyId])).rows[0].n, 0);
});

test('m9d902 a atividade "última carga delta" dispara a execução com lastDelta true', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const res = await call('gestor', 'POST', '/migration/runs', { sourceSystem: 'LEGADO_ERP', entity: 'PERSON', lastDelta: true });
  assert.equal(res.status, 202);
  const [row] = (await adminQuery('SELECT last_delta FROM governance.mig_runs WHERE id = $1', [res.body.data.runId])).rows;
  assert.equal(row.last_delta, true, 'a execução da última carga delta compara as chaves das fontes WATERMARK (M9-D900)');
  for (let i = 0; i < 60; i += 1) {
    const [state] = (await adminQuery('SELECT status FROM governance.mig_runs WHERE id = $1', [res.body.data.runId])).rows;
    if (['SUCCEEDED', 'FAILED'].includes(state.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});
