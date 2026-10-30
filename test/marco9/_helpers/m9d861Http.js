'use strict';

// Servidor HTTP real dos testes M9-D861/M9-D862 (não é teste): perfis A:gestor (leitura + gestão de FinOps), A:leitura (sem nada de governança) e B:gestor.
// Banco descartável obrigatório (nunca o .env remoto). A porta vem de process.env.PORT, definido pelo teste ANTES do require deste arquivo.
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

const CODES = ['governance:finops:read', 'governance:finops:manage'];
const state = { baseUrl: null, tokens: {}, tenants: null, skip: null, loaded: false };

async function setPermissions(role, codes) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)', [role, CODES]);
  if (codes.length) await adminQuery('INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)', [role, codes]);
}

async function login(tenant, profile, password) {
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${state.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(tenant, profile), password }) });
    const body = await res.json();
    if (res.status !== 409) { assert.equal(res.status, 200, `login ${tenant}/${profile}`); return body.data.accessToken; }
    await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
  }
  throw new Error('login não concluiu');
}

async function start() {
  if (!DISPOSABLE) { state.skip = SKIP_DISPOSABLE; return state; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) { state.skip = 'seed de dois tenants ausente.'; return state; }
  state.tenants = await loadTenants();
  await setPermissions('CI GESTOR', CODES);
  await setPermissions('CI LEITURA', []);
  require('../../../app');
  state.loaded = true;
  state.baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]) state.tokens[`${tenant}:${profile}`] = await login(tenant, profile, password);
  return state;
}

async function call(who, method, route, body) {
  const res = await fetch(`${state.baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${state.tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function stop() {
  if (!state.loaded) return;
  await setPermissions('CI GESTOR', ['governance:finops:read']);
  setTimeout(() => process.exit(0), 300);
}

module.exports = { start, stop, call, state, adminQuery };
