'use strict';

// M9-D413 — rotas de automação por HTTP real (login do seed de dois tenants): criar (201), 422 com a lista de itens ausentes, publicar
// v4 com v3 SUPERSEDED, pausar, retomar, permissões e isolamento entre empresas. Nenhum endpoint de MFA é
// chamado nem token forjado. Rodar SOMENTE em banco descartável (node scripts/withDisposableDb.js).

process.env.PORT = process.env.M9D413_HTTP_TEST_PORT || '21713';

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
     VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D413', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName])).rows[0].id;
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
  await roleFor('A', 'leitura', 'QA-M9 D413 autor', ['marketing:automation:manage']);
  await roleFor('A', 'gestor', 'QA-M9 D413 gerente', ['marketing:automation:manage', 'marketing:automation:publish']);
  await roleFor('B', 'gestor', 'QA-M9 D413 gerente B', ['marketing:automation:manage', 'marketing:automation:publish']);
  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 400));
  await login('autor', 'A', 'leitura');
  await login('gerenteA', 'A', 'gestor');
  await login('gerenteB', 'B', 'gestor');
});

after(async () => {
  if (DISPOSABLE) {
    const flows = "SELECT id FROM marketing.automation_flows WHERE name LIKE 'QA-M9 D413%'";
    await adminQuery(`UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id IN (${flows})`).catch(() => {});
    await adminQuery(`DELETE FROM marketing.automation_versions WHERE flow_id IN (${flows})`).catch(() => {});
    await adminQuery("DELETE FROM marketing.automation_flows WHERE name LIKE 'QA-M9 D413%'").catch(() => {});
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

test('rotas_de_automacao_exigem_permissao_listam_o_que_falta_e_publicam_v4', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  const me = await adminQuery("SELECT u.id FROM core.users u JOIN core.user_memberships m ON m.user_id = u.id WHERE m.company_id = (SELECT company_id FROM core.user_memberships mm JOIN core.users uu ON uu.id = mm.user_id WHERE uu.email = $1 LIMIT 1) AND u.status = 'ACTIVE' LIMIT 1",
    [require('../scripts/seed-ci-two-tenants').emailFor('A', 'gestor')]);
  const owner = me.rows[0].id;
  const body = (over = {}) => ({
    name: `QA-M9 D413 ${Math.random().toString(16).slice(2, 8)}`, ownerUserId: owner, riskLevel: 'MEDIUM', triggerType: 'EVENT',
    triggerConfig: { eventType: 'crm.opportunity.created' }, conditions: ['LEAD_SEM_RETORNO'],
    actions: [{ actionType: 'CREATE_TASK', title: 'Ligar para o lead' }, { actionType: 'SEND_MESSAGE', channel: 'WHATSAPP' }], cooldown: { amount: 72, unit: 'HOURS' },
    frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' }, validFrom: '2026-01-01T00:00:00Z', ...over,
  });

  assert.equal((await call(null, 'POST', '/marketing/automations', body())).status, 401);
  // 422 MKT_AUTOMATION_INCOMPLETE lista os itens ausentes
  const incomplete = await call('autor', 'POST', '/marketing/automations', { name: 'QA-M9 D413 incompleta', ownerUserId: owner, triggerType: 'EVENT', triggerConfig: {}, actions: [] });
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.error.code, 'MKT_AUTOMATION_INCOMPLETE');
  const missing = incomplete.body.error.details.items.map((i) => i.field);
  for (const f of ['triggerConfig.eventType', 'conditions', 'actions', 'cooldown', 'frequencyCap', 'riskLevel']) assert.ok(missing.includes(f), `${f} em ${missing}`);
  assert.equal((await call('autor', 'POST', '/marketing/automations', body({ actions: [{ actionType: 'PAGAR' }] }))).body.error.code, 'MKT_AUTOMATION_ACTION_UNKNOWN');

  const created = await call('autor', 'POST', '/marketing/automations', body());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const flowId = created.body.data.flow.id;
  assert.equal(created.body.data.flow.status, 'PAUSED');
  // autor (manage) não publica: 403 com a permissão exigida
  const denied = await call('autor', 'POST', `/marketing/automations/${flowId}/publish`, { versionNo: 1, reason: 'Publicação de teste.' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.details.required, 'marketing:automation:publish');

  for (let i = 0; i < 3; i += 1) assert.equal((await call('autor', 'POST', '/marketing/automations', { flowId, cooldown: { amount: 48 + i, unit: 'HOURS' } })).status, 201);
  assert.equal((await call('gerenteA', 'POST', `/marketing/automations/${flowId}/publish`, { reason: 'Sem número da versão.' })).status, 422);
  assert.equal((await call('gerenteA', 'POST', `/marketing/automations/${flowId}/publish`, { versionNo: 7, reason: 'Versão que não existe.' })).status, 404);
  assert.equal((await call('gerenteA', 'POST', `/marketing/automations/${flowId}/publish`, { versionNo: 3, reason: 'Publicar a v3 do fluxo.' })).status, 200);
  const v4 = await call('gerenteA', 'POST', `/marketing/automations/${flowId}/publish`, { versionNo: 4, reason: 'Publicar a v4 do fluxo.' });
  assert.equal(v4.status, 200, JSON.stringify(v4.body));
  assert.deepEqual(v4.body.data.superseded, { versionNo: 3, status: 'SUPERSEDED' });
  assert.deepEqual(v4.body.data.versions.map((v) => `${v.versionNo}:${v.status}`), ['1:DRAFT', '2:DRAFT', '3:SUPERSEDED', '4:PUBLISHED']);
  assert.equal((await call('gerenteA', 'POST', `/marketing/automations/${flowId}/publish`, { versionNo: 3, reason: 'Voltar para a v3.' })).body.error.code, 'MKT_AUTOMATION_VERSION_IMMUTABLE');

  // pausar (manage) e retomar (publish)
  const paused = await call('autor', 'POST', `/marketing/automations/${flowId}/pause`, { reason: 'Pausa de teste.' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.data.flow.status, 'PAUSED');
  assert.equal(paused.body.data.version.status, 'PAUSED');
  const resumed = await call('gerenteA', 'POST', `/marketing/automations/${flowId}/publish`, { versionNo: 4, reason: 'Retomar a automação.' });
  assert.equal(resumed.body.data.flow.status, 'ACTIVE');

  // outra empresa não enxerga
  assert.equal((await call('gerenteB', 'POST', `/marketing/automations/${flowId}/pause`, {})).status, 404);
  assert.equal((await call('gerenteB', 'POST', '/marketing/automations', { flowId })).status, 404);
});
