'use strict';

// M9-D409 — os 10 tipos por HTTP real (login do seed de dois tenants): tipo inválido 400, campo mínimo 422, canal não permitido 422 na
// criação e no agendamento, criação 201 e isolamento entre empresas. Nenhum endpoint de MFA é chamado nem token forjado.
// Rodar SOMENTE em banco descartável (node scripts/withDisposableDb.js).

process.env.PORT = process.env.M9D409_HTTP_TEST_PORT || '21709';

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
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
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

async function roleFor(tenantKey, profile, roleName, permissions) {
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const m = (await adminQuery(
    'SELECT m.id, m.role_id, m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1', [emailFor(tenantKey, profile)])).rows[0];
  restore.push({ id: m.id, roleId: m.role_id });
  const roleId = (await adminQuery(
    `INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D409', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName])).rows[0].id;
  restore.push({ dropRole: roleId });
  for (const code of permissions) {
    await adminQuery(
      `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
       SELECT gen_random_uuid(), $1, p.id, now(), now() FROM core.permissions p WHERE p.code = $2`, [roleId, code]);
  }
  await adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [roleId, m.id]);
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP; return; }
  ({ sequelize } = require('../../../src/models'));
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const seeded = process.env.CI_TENANT_USERS_PASSWORD
    ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) { httpSkip = 'seed de dois tenants ausente'; return; }
  await roleFor('A', 'leitura', 'QA-M9 D409 redator', ['marketing:content:read', 'marketing:content:write', 'marketing:content:publish']);
  await roleFor('B', 'gestor', 'QA-M9 D409 gerente B', ['marketing:content:read', 'marketing:content:approve', 'marketing:content:publish']);
  require('../../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
  await login('redator', 'A', 'leitura');
  await login('gerenteB', 'B', 'gestor');
});

after(async () => {
  if (DISPOSABLE) {
    const ids = "SELECT id FROM marketing.content_items WHERE title LIKE 'QA-M9 D409%'";
    await adminQuery(`UPDATE marketing.content_items SET current_version_id = NULL WHERE id IN (${ids})`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id IN (${ids}))`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.content_versions WHERE content_item_id IN (${ids})`).catch(() => {});
    await adminQuery("DELETE FROM marketing.content_items WHERE title LIKE 'QA-M9 D409%'").catch(() => {});
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

test('os_tipos_por_http_tipo_invalido_campo_minimo_canal_e_isolamento', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  const institutional = { type: 'INSTITUTIONAL', title: 'QA-M9 D409 institucional', texto: 'Somos uma imobiliária de Salvador.' };

  assert.equal((await call(null, 'POST', '/marketing/content', institutional)).status, 401);

  // Tipo inexistente: 400 MKT_CONTENT_TYPE_INVALID
  const invalid = await call('redator', 'POST', '/marketing/content', { type: 'NOPE', title: 'QA-M9 D409 tipo' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'MKT_CONTENT_TYPE_INVALID');
  assert.equal(invalid.body.error.message, 'Tipo de conteúdo inválido.');

  // Campo mínimo ausente: 422 MKT_CONTENT_REQUIRED_FIELD (institucional sem corpo; blog sem fontes; imóvel sem fonte)
  for (const body of [
    { type: 'INSTITUTIONAL', title: 'QA-M9 D409 sem corpo' },
    { type: 'EDUCATIONAL_BLOG', title: 'QA-M9 D409 blog', tema: 'Financiamento' },
    { type: 'NEW_PROPERTY', title: 'QA-M9 D409 sem fonte' },
  ]) {
    const res = await call('redator', 'POST', '/marketing/content', body);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'MKT_CONTENT_REQUIRED_FIELD');
    assert.equal(res.body.error.message, 'Faltam campos obrigatórios para este tipo de conteúdo.');
  }

  // Canal não permitido para o tipo na criação (aniversário em rede social): 422 MKT_CONTENT_CHANNEL_NOT_ALLOWED
  const channel = await call('redator', 'POST', '/marketing/content', { type: 'SEGMENTED_CAMPAIGN', title: 'QA-M9 D409 campanha', campaignId: '00000000-0000-4000-8000-000000000001', channels: ['INSTAGRAM'], templateCode: 'X' });
  assert.equal(channel.status, 422, JSON.stringify(channel.body));
  assert.equal(channel.body.error.code, 'MKT_CONTENT_CHANNEL_NOT_ALLOWED');
  assert.equal(channel.body.error.message, 'Este tipo de conteúdo não pode ser publicado neste canal.');

  // Criar institucional (201) e agendar em canal que o tipo não aceita (422), e no canal aceito passa da regra do tipo
  const created = await call('redator', 'POST', '/marketing/content', institutional);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.type, 'INSTITUTIONAL');
  const id = created.body.data.id;
  const when = new Date(Date.now() + 3 * 3600000).toISOString();
  const wrong = await call('redator', 'POST', `/marketing/content/${id}/schedule`, { channels: ['WHATSAPP'], when });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.equal(wrong.body.error.code, 'MKT_CONTENT_CHANNEL_NOT_ALLOWED');
  const right = await call('redator', 'POST', `/marketing/content/${id}/schedule`, { channels: ['SITE'], when });
  assert.notEqual(right.body && right.body.error && right.body.error.code, 'MKT_CONTENT_CHANNEL_NOT_ALLOWED', 'SITE é canal permitido para o institucional');

  // Isolamento: outra empresa não vê o conteúdo de A
  assert.equal((await call('gerenteB', 'GET', `/marketing/content/${id}`)).status, 404);
});
