'use strict';

// Servidor HTTP real dos testes de Marketing (não é teste): perfis do seed de dois tenants com papéis criados no banco DESCARTÁVEL e restaurados no fim.
// Nunca chama endpoint de MFA nem forja token. A porta vem de process.env.PORT, definido pelo teste ANTES do require deste arquivo.
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery } = require('../../m9d801.helpers');

const state = { baseUrl: null, tokens: {}, skip: null, restore: [], loaded: false };

async function roleFor(tenantKey, profile, roleName, permissions) {
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const m = (await adminQuery('SELECT m.id, m.role_id, m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1', [emailFor(tenantKey, profile)])).rows[0];
  state.restore.push({ id: m.id, roleId: m.role_id });
  const roleId = (await adminQuery(`INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 teste de Marketing', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName])).rows[0].id;
  state.restore.push({ dropRole: roleId });
  for (const code of permissions) {
    await adminQuery('INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), $1, p.id, now(), now() FROM core.permissions p WHERE p.code = $2', [roleId, code]);
  }
  await adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [roleId, m.id]);
}

async function login(label, tenantKey, profile) {
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  let res; let body;
  for (let i = 0; i < 5; i += 1) {
    res = await fetch(`${state.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(tenantKey, profile), password: process.env.CI_TENANT_USERS_PASSWORD }) });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  assert.equal(res.status, 200, `login ${label}`);
  state.tokens[label] = body.data.accessToken;
}

/** roles: [{ label, tenant: 'A'|'B', profile: 'gestor'|'leitura', permissions: [...] }] */
async function start(roles) {
  if (!DISPOSABLE) { state.skip = SKIP_DISPOSABLE; return state; }
  if (!process.env.CI_TENANT_USERS_PASSWORD) { state.skip = 'seed de dois tenants ausente.'; return state; }
  for (const r of roles) await roleFor(r.tenant, r.profile, `QA-M9 ${r.label}`, r.permissions);
  require('../../../app');
  state.loaded = true;
  state.baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
  for (const r of roles) await login(r.label, r.tenant, r.profile);
  return state;
}

async function call(who, method, route, body) {
  const res = await fetch(`${state.baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${state.tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Apaga o que o teste commitou (conteúdo com o prefixo no título) e restaura os papéis. */
async function stop(titlePrefix) {
  if (!DISPOSABLE) return;
  if (titlePrefix) {
    const ids = `SELECT id FROM marketing.content_items WHERE title LIKE '${titlePrefix}%'`;
    await adminQuery(`UPDATE marketing.content_items SET current_version_id = NULL WHERE id IN (${ids})`).catch(() => {});
    await adminQuery(`DELETE FROM integration.dispatches WHERE aggregate_id IN (${ids})`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.publication_results WHERE job_id IN (SELECT id FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id IN (${ids})))`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id IN (${ids}))`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.content_versions WHERE content_item_id IN (${ids})`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.content_items WHERE title LIKE '${titlePrefix}%'`).catch(() => {});
  }
  for (const r of state.restore.reverse()) {
    if (r.dropRole) {
      await adminQuery('DELETE FROM core.role_permissions WHERE role_id = $1', [r.dropRole]).catch(() => {});
      await adminQuery('DELETE FROM core.roles WHERE id = $1', [r.dropRole]).catch(() => {});
    } else await adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [r.roleId, r.id]).catch(() => {});
  }
}

module.exports = { start, call, stop, state, DISPOSABLE, SKIP_DISPOSABLE, adminQuery };
