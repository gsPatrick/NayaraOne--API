'use strict';

// Apoio HTTP dos testes M9-D806/D808 (não é teste): sobe a API real no banco descartável, concede permissões aos perfis de CI e faz login por perfil.
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

const GOVERNANCE_PERMISSIONS = ['governance:data-quality:read', 'governance:data-quality:manage', 'governance:data-quality:bulk'];

// Linhas de role_permissions que ESTE helper inseriu, por papel: `setPermissions(papel, [])` remove também as concedidas fora de GOVERNANCE_PERMISSIONS (ex.: governance:api:manage),
// que antes ficavam no papel e faziam o gestor virar dono de módulos nos arquivos seguintes do mesmo banco (m9d870.modulos).
const inseridas = new Map();

/** Define exatamente quais permissões de dados mestres o perfil (por nome do papel, nas duas empresas) tem. */
async function setPermissions(roleName, codes) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)', [roleName, GOVERNANCE_PERMISSIONS]);
  const anteriores = inseridas.get(roleName) || [];
  inseridas.delete(roleName);
  if (anteriores.length) await adminQuery('DELETE FROM core.role_permissions WHERE id = ANY($1::uuid[])', [anteriores]);
  if (!codes.length) return;
  const { rows } = await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2) RETURNING id`, [roleName, codes]);
  inseridas.set(roleName, rows.map((r) => r.id));
}

/** { baseUrl, tenants, tokens, call, skip, close } — `logins` = { apelido: [tenant, perfil] }. */
async function startHttp({ port, grants = {}, logins }) {
  if (!DISPOSABLE) return { skip: SKIP_DISPOSABLE };
  process.env.PORT = process.env.PORT || String(port);
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) return { skip: 'seed de dois tenants ausente.' };
  const tenants = await loadTenants();
  for (const [roleName, codes] of Object.entries(grants)) await setPermissions(roleName, codes);
  require('../../../app');
  const baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const tokens = {};
  for (const [alias, [tenantKey, profile]] of Object.entries(logins)) {
    let res; let body;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(tenantKey, profile), password }) });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${alias}`);
    tokens[alias] = body.data.accessToken;
  }
  const call = async (who, method, path, body, headers = {}) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { baseUrl, tenants, tokens, call, skip: null };
}

async function stopHttp(grants) {
  if (!DISPOSABLE) return;
  for (const roleName of Object.keys(grants)) await setPermissions(roleName, []).catch(() => {});
  await require('../../../src/models').sequelize.close().catch(() => {});
  setTimeout(() => process.exit(0), 300);
}

module.exports = { startHttp, stopHttp, setPermissions };
