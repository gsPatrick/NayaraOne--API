'use strict';

// M9-D417 — escrita dos parâmetros de cadência por HTTP: permissão, 422, 404, idempotência e auditoria por HTTP real (login do seed de dois tenants).
// Rodar SOMENTE em banco descartável (veja m9d404.templates.test.js). Nenhum endpoint de MFA é chamado nem token forjado.

process.env.PORT = process.env.M9D417_HTTP_TEST_PORT || '21717';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';
let baseUrl; let appLoaded = false; let httpSkip = null; let sequelize;
const tokens = {}; const restore = [];

async function adminQuery(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

async function login(label, tenantKey, profile) {
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  let res; let body;
  for (let i = 0; i < 5; i += 1) {
    res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailFor(tenantKey, profile), password: process.env.CI_TENANT_USERS_PASSWORD }),
    });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  assert.equal(res.status, 200, `login ${label}: ${JSON.stringify(body)}`);
  tokens[label] = body.data.accessToken;
}

async function roleFor(tenantKey, profile, roleName, extraPermissions) {
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const email = emailFor(tenantKey, profile);
  const m = (await adminQuery(
    `SELECT m.id, m.role_id, m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1`, [email])).rows[0];
  restore.push({ id: m.id, roleId: m.role_id });
  const created = await adminQuery(
    `INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D417', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName]);
  const roleId = created.rows[0].id;
  restore.push({ dropRole: roleId });
  for (const code of extraPermissions) {
    await adminQuery(
      `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
       SELECT gen_random_uuid(), $1, p.id, now(), now() FROM core.permissions p WHERE p.code = $2`, [roleId, code]);
  }
  await adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [roleId, m.id]);
  return m;
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP; return; }
  ({ sequelize } = require('../src/models'));
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const seeded = process.env.CI_TENANT_USERS_PASSWORD
    ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) { httpSkip = 'seed de dois tenants ausente'; return; }
  await roleFor('A', 'leitura', 'QA-M9 D417 so-settings', ['settings:read', 'settings:update']);
  await roleFor('A', 'gestor', 'QA-M9 D417 gestor', ['settings:read', 'settings:update', 'marketing:automation:manage']);
  await roleFor('B', 'gestor', 'QA-M9 D417 gestor B', ['settings:read', 'settings:update', 'marketing:automation:manage']);
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
  await login('semPermissao', 'A', 'leitura');
  await login('gestorA', 'A', 'gestor');
  await login('gestorB', 'B', 'gestor');
});

after(async () => {
  if (DISPOSABLE) {
    // As configurações criadas por HTTP foram COMMITADAS: remove-as para não contaminar os outros arquivos.
    await adminQuery("DELETE FROM core.tenant_settings WHERE key LIKE 'marketing.cadencia.%' OR key LIKE 'marketing.quiet_hours%' OR key LIKE 'marketing.frequency_cap.%'").catch(() => {});
    for (const r of restore.reverse()) {
      if (r.dropRole) {
        await adminQuery('DELETE FROM core.role_permissions WHERE role_id = $1', [r.dropRole]).catch(() => {});
        await adminQuery('DELETE FROM core.roles WHERE id = $1', [r.dropRole]).catch(() => {});
      } else {
        await adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [r.roleId, r.id]).catch(() => {});
      }
    }
  }
  if (sequelize) await sequelize.close().catch(() => {});
  if (appLoaded) setTimeout(() => process.exit(0), 300);
});

async function call(who, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const K = 'marketing.cadencia.pos_chaves_dias';
const put = (who, key, value) => call(who, 'PUT', `/settings/${key}`, { value });
const auditCount = async (key) => Number((await adminQuery(
  "SELECT count(*) AS n FROM audit.audit_log WHERE entity_type = 'TenantSetting' AND after_json->>'key' = $1", [key])).rows[0].n);

test('alteracao_exige_permissao_e_gera_auditoria', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  assert.equal((await put(null, K, '[3,45]')).status, 401);
  const denied = await put('semPermissao', K, '[3,45]');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'MKT_FORBIDDEN');
  assert.equal(denied.body.error.details.required, 'marketing:automation:manage');
  // A auditoria é append-only e fica entre execuções no mesmo banco: conta-se sempre RELATIVO ao estado inicial deste teste.
  const base = await auditCount(K);
  assert.equal(await auditCount(K), base);

  // Começa do padrão: remove o valor gravado por uma execução anterior (senão o PUT inicial seria "sem mudança" e não auditaria).
  await adminQuery('DELETE FROM core.tenant_settings WHERE key = $1', [K]);
  const ok = await put('gestorA', K, '[3,45,120,365]');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await auditCount(K), base + 1);

  // PUT repetido com o mesmo valor (mesmo em outra grafia) não gera nova versão nem nova auditoria.
  const same = await put('gestorA', K, '3, 45, 120, 365');
  assert.equal(same.status, 200);
  assert.equal(await auditCount(K), base + 1);

  // Valor novo: nova versão com antes e depois na auditoria.
  assert.equal((await put('gestorA', K, '[3,60]')).status, 200);
  assert.equal(await auditCount(K), base + 2);
  const rows = (await adminQuery(
    "SELECT before_json->>'value' AS antes, after_json->>'value' AS depois, user_id FROM audit.audit_log WHERE entity_type = 'TenantSetting' AND after_json->>'key' = $1 ORDER BY occurred_at DESC LIMIT 1", [K])).rows;
  assert.equal(rows[0].antes, '[3,45,120,365]');
  assert.equal(rows[0].depois, '[3,60]');
  assert.ok(rows[0].user_id);
});

test('valor_invalido_e_chave_desconhecida_por_http', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  const invalid = await put('gestorA', 'marketing.quiet_hours', '25:00 a 08:00 America/Sao_Paulo');
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'MKT_PARAM_INVALID');
  assert.equal(invalid.body.error.message, 'Valor inválido para o parâmetro.');
  const unknown = await put('gestorA', 'marketing.cadencia.inexistente', '[1,2,3]');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'MKT_PARAM_NOT_FOUND');
  // Chave desconhecida da família é 404 para qualquer pessoa autenticada com settings:update.
  assert.equal((await put("semPermissao", "marketing.cadencia.inexistente", "[1,2,3]")).status, 404);
});

test('parametro_de_uma_empresa_nao_vaza_para_outra', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  assert.equal((await put('gestorA', 'marketing.cadencia.sem_retorno_dias', '[2,4]')).status, 200);
  const b = await call('gestorB', 'GET', '/settings/marketing.cadencia.sem_retorno_dias');
  assert.equal(b.status, 404);
  const a = await call('gestorA', 'GET', '/settings/marketing.cadencia.sem_retorno_dias');
  assert.equal(a.body.data.value, '[2,4]');
});
