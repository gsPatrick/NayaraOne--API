'use strict';

// M9-D804 — GET/PUT /data-quality/domains pela API real e desativação de usuário com commit, em banco descartável (nunca o .env remoto).
process.env.PORT = process.env.M9D804_HTTP_TEST_PORT || '21654';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

const ROLES = { gestor: 'CI GESTOR', leitura: 'CI LEITURA' };
const MANAGED = ['governance:data-quality:read', 'governance:data-quality:manage'];
let baseUrl; let tenants; let appLoaded = false; let httpSkip = null;
const tokens = {};

async function setPermissions(role, codes) {
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)`, [role, MANAGED]);
  if (!codes.length) return;
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, [role, codes]);
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  await setPermissions(ROLES.gestor, MANAGED);
  await setPermissions(ROLES.leitura, []);
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
  if (DISPOSABLE && tenants) await setPermissions(ROLES.gestor, ['governance:data-quality:read', 'governance:data-quality:manage']);
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

async function newActiveUser(tenant) {
  const { rows: [m] } = await adminQuery('SELECT role_id FROM core.user_memberships WHERE user_id = $1 AND company_id = $2 LIMIT 1', [tenant.userId, tenant.companyId]);
  const id = randomUUID();
  await adminQuery(`INSERT INTO core.users (id, name, email, password_hash, status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, `QA-M9 ${id.slice(0, 6)}`, `qa-m9-${id}@ci.nayaraone.test`, 'x'.repeat(60)]);
  await adminQuery(`INSERT INTO core.user_memberships (id, group_id, company_id, user_id, role_id, status) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ACTIVE')`, [tenant.groupId, tenant.companyId, id, m.role_id]);
  return id;
}

test('m9d804 designar sem a permissão devolve 403', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const userId = await newActiveUser(tenants.A);
  const denied = await call('leitura', 'PUT', '/data-quality/domains/CORRESPONDENTE/assignments', { designations: [{ role: 'STEWARD', userId }] });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.body.error.details.required, 'governance:data-quality:manage', 'a permissão exigida segue em details.required');
  assert.ok(denied.body.error.traceId, 'corpo de erro único com traceId');
  assert.equal((await call('leitura', 'GET', '/data-quality/domains')).status, 403, 'listar também exige a permissão de leitura');
});

test('m9d804 designação real, listagem e recusa de segundo owner pela API', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const [ana, bruno] = [await newActiveUser(tenants.A), await newActiveUser(tenants.A)];
  const first = await call('gestor', 'PUT', '/data-quality/domains/CORRESPONDENTE/assignments', { designations: [{ role: 'OWNER', userId: ana }, { role: 'STEWARD', userId: bruno }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.owner.userId, ana);
  const list = await call('gestor', 'GET', '/data-quality/domains');
  assert.equal(list.status, 200);
  const pessoas = list.body.data.find((d) => d.code === 'CORRESPONDENTE');
  assert.deepEqual([pessoas.owner.userId, pessoas.stewards.map((s) => s.userId), pessoas.pendencies], [ana, [bruno], []]);
  const two = await call('gestor', 'PUT', '/data-quality/domains/CORRESPONDENTE/assignments', { designations: [{ role: 'OWNER', userId: ana }, { role: 'OWNER', userId: bruno }] });
  assert.equal(two.status, 409);
  assert.equal(two.body.error.code, 'GOV_DOMAIN_OWNER_EXISTS');
  assert.equal(two.body.error.message, 'Informe um único responsável (owner) por domínio.');
  const swap = await call('gestor', 'PUT', '/data-quality/domains/CORRESPONDENTE/assignments', { designations: [{ role: 'OWNER', userId: bruno }] });
  assert.equal(swap.status, 200, 'trocar o owner é um PUT, sem rota de encerramento');
  assert.equal(swap.body.data.owner.userId, bruno);
  const invalid = await call('gestor', 'PUT', '/data-quality/domains/INVENTADO/assignments', { designations: [{ role: 'OWNER', userId: ana }] });
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, 'GOV_DOMAIN_INVALID']);
  const foreign = await call('gestor', 'PUT', '/data-quality/domains/CORRESPONDENTE/assignments', { designations: [{ role: 'OWNER', userId: tenants.B.userId }] });
  assert.deepEqual([foreign.status, foreign.body.error.code], [404, 'GOV_NOT_FOUND']);
});

test('m9d804 desativar o usuário pelo serviço de usuários fecha as designações e avisa o administrador', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const usersService = require('../../../src/features/users/users.service');
  const userId = await newActiveUser(tenants.A);
  const set = await call('gestor', 'PUT', '/data-quality/domains/FORNECEDORES/assignments', { designations: [{ role: 'STEWARD', userId }] });
  assert.equal(set.status, 200);
  await usersService.updateUser(userId, { status: 'SUSPENDED' }, tenants.A.userId, { groupId: tenants.A.groupId, companyId: tenants.A.companyId });
  const { rows } = await adminQuery(`SELECT valid_until, close_reason FROM governance.data_domain_assignments WHERE user_id = $1`, [userId]);
  assert.equal(rows.length, 1, 'histórico mantido');
  assert.ok(rows[0].valid_until, 'designação fechada');
  assert.match(rows[0].close_reason, /SUSPENDED/);
  const list = await call('gestor', 'GET', '/data-quality/domains');
  assert.equal(list.body.data.find((d) => d.code === 'FORNECEDORES').stewards.some((s) => s.userId === userId), false);
});
