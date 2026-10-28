'use strict';

// M9-D404 — rotas de template: permissão, erros e isolamento entre empresas por HTTP real (login do seed de dois tenants).
// Rodar SOMENTE em banco descartável (veja m9d404.templates.test.js). Nenhum endpoint de MFA é chamado nem token forjado.

process.env.PORT = process.env.M9D404_HTTP_TEST_PORT || '21704';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { templateInput, uid } = require('./helpers/m9d404Fixtures');

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
     VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D404', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName]);
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
  await roleFor('A', 'leitura', 'QA-M9 D404 leitor', ['marketing:content:read', 'marketing:content:write']);
  await roleFor('A', 'gestor', 'QA-M9 D404 gestor', ['marketing:content:read', 'marketing:template:manage']);
  await roleFor('B', 'gestor', 'QA-M9 D404 gestor B', ['marketing:content:read', 'marketing:template:manage']);
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
  await login('leitor', 'A', 'leitura');
  await login('gestorA', 'A', 'gestor');
  await login('gestorB', 'B', 'gestor');
});

after(async () => {
  if (DISPOSABLE) {
    // Os templates criados por HTTP foram COMMITADOS: remove-os para não contaminar os testes de schema dos outros arquivos.
    await adminQuery("DELETE FROM marketing.templates WHERE code LIKE 'qa-m9-%'").catch(() => {});
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

test('rotas_de_template_exigem_permissao_e_isolam_empresas', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  const input = templateInput();
  // Sem token: 401. Leitor (content:read/write, sem template:manage): 403 MKT_FORBIDDEN nas duas rotas de escrita.
  assert.equal((await call(null, 'POST', '/marketing/templates', input)).status, 401);
  const denied = await call('leitor', 'POST', '/marketing/templates', input);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'MKT_FORBIDDEN');
  assert.equal(denied.body.error.details.required, 'marketing:template:manage');
  const deniedPublish = await call('leitor', 'POST', `/marketing/templates/${uid()}/publish`);
  assert.equal(deniedPublish.status, 403);
  assert.equal(deniedPublish.body.error.code, 'MKT_FORBIDDEN');

  // Gestor com template:manage cria (201), publica (200) e repete (200 idempotente).
  const created = await call('gestorA', 'POST', '/marketing/templates', input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.versionNo, 1);
  const published = await call('gestorA', 'POST', `/marketing/templates/${id}/publish`);
  assert.equal(published.status, 200);
  assert.equal(published.body.data.template.status, 'PUBLISHED');
  const replay = await call('gestorA', 'POST', `/marketing/templates/${id}/publish`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.replay, true);

  // Leitura: o leitor tem content:read e vê o histórico; sem token 401.
  const list = await call('leitor', 'GET', `/marketing/templates?code=${input.code}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items[0].versions[0].status, 'PUBLISHED');
  assert.equal((await call(null, 'GET', '/marketing/templates')).status, 401);

  // Erros por rota: 422 variável desconhecida e referência oficial; 400 de validação.
  const unknown = await call('gestorA', 'POST', '/marketing/templates', templateInput({ body: 'oi {{cor_do_carro}}' }));
  const unknownPub = await call('gestorA', 'POST', `/marketing/templates/${unknown.body.data.id}/publish`);
  assert.equal(unknownPub.status, 422);
  assert.equal(unknownPub.body.error.code, 'MKT_TEMPLATE_UNKNOWN_VARIABLE');
  const wa = await call('gestorA', 'POST', '/marketing/templates', templateInput({ kind: 'MESSAGE', channel: 'WHATSAPP' }));
  const waPub = await call('gestorA', 'POST', `/marketing/templates/${wa.body.data.id}/publish`);
  assert.equal(waPub.status, 422);
  assert.equal(waPub.body.error.code, 'MKT_TEMPLATE_OFFICIAL_REF_REQUIRED');
  assert.equal((await call('gestorA', 'POST', '/marketing/templates', { code: 'x' })).status, 400);
  assert.equal((await call('gestorA', 'POST', `/marketing/templates/nao-e-uuid/publish`)).status, 404);

  // Isolamento: outra empresa (com a mesma permissão) não vê nem publica o template de A: 404 MKT_NOT_FOUND.
  const crossPublish = await call('gestorB', 'POST', `/marketing/templates/${id}/publish`);
  assert.equal(crossPublish.status, 404);
  assert.equal(crossPublish.body.error.code, 'MKT_NOT_FOUND');
  const crossList = await call('gestorB', 'GET', `/marketing/templates?code=${input.code}`);
  assert.equal(crossList.status, 200);
  assert.equal(crossList.body.data.total, 0);
});
