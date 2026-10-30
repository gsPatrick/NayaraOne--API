'use strict';

// M9-D406 — rotas do conteúdo por HTTP real (login do seed de dois tenants): criar, linha do tempo, aprovar sem validação (409),
// agendar (422 cedo demais, 201, 200 em replay), NAY indisponível (503) e isolamento entre empresas. Nenhum endpoint de MFA é
// chamado nem token forjado. Rodar SOMENTE em banco descartável (node scripts/withDisposableDb.js).

process.env.PORT = process.env.M9D406_HTTP_TEST_PORT || '21706';

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

async function roleFor(tenantKey, profile, roleName, permissions) {
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const m = (await adminQuery(
    'SELECT m.id, m.role_id, m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1', [emailFor(tenantKey, profile)])).rows[0];
  restore.push({ id: m.id, roleId: m.role_id });
  const roleId = (await adminQuery(
    `INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D406', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName])).rows[0].id;
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
  ({ sequelize } = require('../src/models'));
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const seeded = process.env.CI_TENANT_USERS_PASSWORD
    ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) { httpSkip = 'seed de dois tenants ausente'; return; }
  await roleFor('A', 'leitura', 'QA-M9 D406 redator', ['marketing:content:read', 'marketing:content:write']);
  await roleFor('A', 'gestor', 'QA-M9 D406 gerente', ['marketing:content:read', 'marketing:content:approve', 'marketing:content:publish']);
  await roleFor('B', 'gestor', 'QA-M9 D406 gerente B', ['marketing:content:read', 'marketing:content:approve', 'marketing:content:publish']);
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
  await login('redator', 'A', 'leitura');
  await login('gerenteA', 'A', 'gestor');
  await login('gerenteB', 'B', 'gestor');
});

after(async () => {
  if (DISPOSABLE) {
    const ids = "SELECT id FROM marketing.content_items WHERE title LIKE 'QA-M9 D406%'";
    await adminQuery(`UPDATE marketing.content_items SET current_version_id = NULL WHERE id IN (${ids})`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id IN (${ids}))`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.content_versions WHERE content_item_id IN (${ids})`).catch(() => {});
    await adminQuery("DELETE FROM marketing.content_items WHERE title LIKE 'QA-M9 D406%'").catch(() => {});
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

test('rotas_de_conteudo_percorrem_o_pipeline_recusam_pulo_e_isolam_empresas', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  const manual = { type: 'INSTITUTIONAL', title: 'QA-M9 D406 institucional', texto: 'Somos uma imobiliária de Salvador.' };

  // Permissões: sem token 401; quem só redige não aprova nem agenda (403 MKT_FORBIDDEN com a permissão exigida).
  assert.equal((await call(null, 'POST', '/marketing/content', manual)).status, 401);
  const unknown = await call('redator', 'POST', '/marketing/content', { ...manual, status: 'APPROVED' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'MKT_VALIDATION');

  // NAY indisponível: 503, e o conteúdo FICA em DRAFT para a redação manual (o id volta nos detalhes).
  const nayDown = await call('redator', 'POST', '/marketing/content', { type: 'EDUCATIONAL_BLOG', title: 'QA-M9 D406 sem NAY', tema: 'Financiamento', fontes: ['https://www.ibge.gov.br/fonte | 2026-10-12'] });
  assert.equal(nayDown.status, 503, JSON.stringify(nayDown.body));
  assert.equal(nayDown.body.error.code, 'MKT_NAY_UNAVAILABLE');
  const draftId = nayDown.body.error.details.contentItemId;
  // Aprovar sem validação: 409 MKT_CONTENT_INVALID_TRANSITION (DRAFT -> APPROVED)
  const early = await call('gerenteA', 'POST', `/marketing/content/${draftId}/approve`, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'MKT_CONTENT_INVALID_TRANSITION');
  // Redação manual do mesmo item segue o pipeline (200 = retomada)
  const resumed = await call('redator', 'POST', '/marketing/content', { contentItemId: draftId, texto: Array.from({ length: 450 }, () => 'texto').join(' ') }); // M9-D427: o blog precisa do mínimo de palavras e de fonte permitida
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.status, 'PENDING_APPROVAL');

  // Criar (201) e linha do tempo (GET): checks_json de cada passo
  const created = await call('redator', 'POST', '/marketing/content', manual);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.status, 'PENDING_APPROVAL');
  const timeline = await call('gerenteA', 'GET', `/marketing/content/${id}`);
  assert.equal(timeline.status, 200);
  assert.deepEqual(Object.keys(timeline.body.data.checks).sort(), ['approval', 'branding', 'compliance', 'facts', 'factual']);

  // Permissões das rotas
  const noApprove = await call('redator', 'POST', `/marketing/content/${id}/approve`, {});
  assert.equal(noApprove.status, 403);
  assert.equal(noApprove.body.error.details.required, 'marketing:content:approve');
  assert.equal((await call('redator', 'POST', `/marketing/content/${id}/schedule`, { channels: ['SITE'], when: new Date().toISOString() })).status, 403);
  assert.equal((await call('redator', 'GET', `/marketing/content/${id}`)).status, 200);

  // Aprovar (gerente) e agendar: cedo demais 422; no prazo 201; repetir 200 (replay)
  const approved = await call('gerenteA', 'POST', `/marketing/content/${id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.status, 'APPROVED');
  const soon = await call('gerenteA', 'POST', `/marketing/content/${id}/schedule`, { channels: ['SITE'], when: new Date(Date.now() + 5 * 60000).toISOString() });
  assert.equal(soon.status, 422);
  assert.equal(soon.body.error.code, 'MKT_SCHEDULE_TOO_SOON');
  const when = new Date(Date.now() + 3 * 3600000).toISOString();
  const scheduled = await call('gerenteA', 'POST', `/marketing/content/${id}/schedule`, { channels: ['SITE', 'INSTAGRAM'], when });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  assert.equal(scheduled.body.data.status, 'SCHEDULED');
  assert.equal(scheduled.body.data.jobs.length, 2);
  assert.equal((await call('gerenteA', 'POST', `/marketing/content/${id}/schedule`, { channels: ['SITE', 'INSTAGRAM'], when })).status, 200);

  // Isolamento: outra empresa não vê nem aprova o conteúdo de A
  assert.equal((await call('gerenteB', 'GET', `/marketing/content/${id}`)).status, 404);
  assert.equal((await call('gerenteB', 'POST', `/marketing/content/${id}/approve`, {})).status, 404);
  assert.equal((await call('gerenteA', 'GET', '/marketing/content/nao-e-uuid')).status, 404);
});
