'use strict';

// Apoio dos testes HTTP da NAY (M9-D016/D017): sobe o app real, concede permissões aos perfis do seed de dois tenants e
// faz login (nunca chama MFA nem forja token). Só roda no cluster descartável.

const assert = require('node:assert/strict');
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = DISPOSABLE ? false : 'precisa do cluster descartável (node scripts/withDisposableDb.js)';

async function admin(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

async function grant(roleName, codes) {
  await admin(
    `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
     SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
      WHERE r.name = $1 AND p.code = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
    [roleName, codes]
  );
}

/** Sobe o app e devolve `{ call, tokens }`. `perfis`: [[tenant, perfil], ...] (ex.: ['A','gestor']). */
async function startHttpEnv(port, perfis) {
  process.env.PORT = String(port);
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  require('../../../app');
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const tokens = {};
  for (const [tenant, profile] of perfis) {
    let res; let data;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(tenant, profile), password: process.env.CI_TENANT_USERS_PASSWORD }) });
      data = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}`);
    tokens[`${tenant}:${profile}`] = data.data.accessToken;
  }
  async function call(method, path, token, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  return { call, tokens };
}

module.exports = { DISPOSABLE, SKIP, admin, grant, startHttpEnv };
