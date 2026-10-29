'use strict';

// M9-D412 — rotas de campanha por HTTP real: permissão, criação em DRAFT, completar/agendar, consulta, isolamento e ausência de
// exportação. Rodar SOMENTE em banco descartável (veja m9d412.campanhas.test.js). Nenhum endpoint de MFA é chamado nem token forjado.

process.env.PORT = process.env.M9D412_HTTP_TEST_PORT || '21712';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';
let baseUrl; let appLoaded = false; let httpSkip = null; let sequelize;
const tokens = {}; const restore = []; const ids = {};
const DAY = 24 * 3600 * 1000;

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
  const m = (await adminQuery(
    'SELECT m.id, m.role_id, m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1', [emailFor(tenantKey, profile)])).rows[0];
  restore.push({ id: m.id, roleId: m.role_id });
  const roleId = (await adminQuery(
    `INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D412', now(), now()) RETURNING id`, [m.group_id, m.company_id, roleName])).rows[0].id;
  restore.push({ dropRole: roleId });
  for (const code of extraPermissions) {
    await adminQuery(
      `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
       SELECT gen_random_uuid(), $1, p.id, now(), now() FROM core.permissions p WHERE p.code = $2`, [roleId, code]);
  }
  await adminQuery('UPDATE core.user_memberships SET role_id = $1 WHERE id = $2', [roleId, m.id]);
  return m;
}

async function seedPeopleAndTemplate(m, label) {
  const person = (await adminQuery(
    `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), $1, $2, 'PF', 'QA-M9 D412', 'ACTIVE') RETURNING id`,
    [m.group_id, m.company_id])).rows[0].id;
  ids[`person${label}`] = person;
  if (label === 'A') {
    ids.template = (await adminQuery(
      `INSERT INTO marketing.templates (id, group_id, company_id, code, version_no, kind, channel, status, body, content_hash)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, 'MESSAGE', 'EMAIL', 'PUBLISHED', 'Olá', $4) RETURNING id`,
      [m.group_id, m.company_id, `qa-m9-d412-${Date.now()}`, crypto.createHash('sha256').update('d412').digest('hex')])).rows[0].id;
  }
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP; return; }
  ({ sequelize } = require('../src/models'));
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const seeded = process.env.CI_TENANT_USERS_PASSWORD
    ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) { httpSkip = 'seed de dois tenants ausente'; return; }
  await roleFor('A', 'leitura', 'QA-M9 D412 leitor', ['marketing:content:read']);
  const mA = await roleFor('A', 'gestor', 'QA-M9 D412 gestor', ['marketing:campaign:manage']);
  const mB = await roleFor('B', 'gestor', 'QA-M9 D412 gestor B', ['marketing:campaign:manage']);
  await seedPeopleAndTemplate(mA, 'A');
  await seedPeopleAndTemplate(mB, 'B');
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
    // As campanhas criadas por HTTP foram COMMITADAS: remove-as (na ordem das FKs) para não contaminar os outros testes de schema.
    for (const sql of [
      "DELETE FROM integration.outbox_events WHERE aggregate_id IN (SELECT id FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%')",
      "DELETE FROM marketing.attribution_events WHERE campaign_id IN (SELECT id FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%')",
      "DELETE FROM marketing.campaign_step_deliveries WHERE campaign_id IN (SELECT id FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%')",
      "DELETE FROM marketing.campaign_audience_members WHERE campaign_id IN (SELECT id FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%')",
      "DELETE FROM marketing.campaign_steps WHERE campaign_id IN (SELECT id FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%')",
      "DELETE FROM marketing.campaign_audiences WHERE campaign_id IN (SELECT id FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%')",
      "DELETE FROM marketing.campaigns WHERE code LIKE 'QA-M9-D412-%'",
      "DELETE FROM marketing.templates WHERE code LIKE 'qa-m9-d412-%'",
      "DELETE FROM people.persons WHERE legal_name = 'QA-M9 D412'",
    ]) await adminQuery(sql).catch(() => {});
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

const bodyOf = (over = {}) => ({
  code: `QA-M9-D412-${crypto.randomUUID().slice(0, 8)}`,
  name: 'Lançamento Aurora',
  objective: 'Gerar 40 visitas agendadas para o lançamento Aurora',
  objectiveMetric: 'VISITS',
  targetValue: 40,
  budgetAmount: 12000,
  startsAt: new Date(Date.now() + 3 * DAY).toISOString(),
  endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  audiences: [{ kind: 'PERSON_LIST', purpose: 'LANCAMENTO', filter: { personIds: [ids.personA] } }],
  steps: [{ channel: 'EMAIL', templateId: ids.template, offsetMinutes: 0 }],
  ...over,
});

test('rotas_de_campanha_exigem_permissao_agendam_e_isolam_empresas', { skip: !DISPOSABLE && SKIP }, async () => {
  if (httpSkip) return;
  assert.equal((await call(null, 'POST', '/marketing/campaigns', bodyOf())).status, 401);
  const denied = await call('leitor', 'POST', '/marketing/campaigns', bodyOf());
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'MKT_FORBIDDEN');
  assert.equal(denied.body.error.details.required, 'marketing:campaign:manage');
  assert.equal((await call('leitor', 'GET', `/marketing/campaigns/${crypto.randomUUID()}`)).status, 403);

  // cria em DRAFT (201), completa (200) e agenda (200); repetir o agendamento devolve 200
  const full = bodyOf();
  const draft = await call('gestorA', 'POST', '/marketing/campaigns', { code: full.code, name: full.name, objective: full.objective });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.data.status, 'DRAFT');
  const id = draft.body.data.id;
  const inc = await call('gestorA', 'POST', '/marketing/campaigns', { campaignId: id, schedule: true });
  assert.equal(inc.status, 422);
  assert.equal(inc.body.error.code, 'MKT_CAMPAIGN_INCOMPLETE');
  const sched = await call('gestorA', 'POST', '/marketing/campaigns', { ...full, campaignId: id, schedule: true });
  assert.equal(sched.status, 200, JSON.stringify(sched.body));
  assert.equal(sched.body.data.status, 'SCHEDULED');
  assert.equal(sched.body.data.audienceSize, 1);
  assert.equal((await call('gestorA', 'POST', '/marketing/campaigns', { campaignId: id, schedule: true })).status, 200);
  const edit = await call('gestorA', 'POST', '/marketing/campaigns', { campaignId: id, name: 'x' });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.error.code, 'MKT_CAMPAIGN_NOT_EDITABLE');

  // consulta: objetivo, público (só a contagem), custo e resultado; sem rota de exportação
  const got = await call('gestorA', 'GET', `/marketing/campaigns/${id}`);
  assert.equal(got.status, 200);
  for (const k of ['objective', 'audienceSize', 'costActual', 'resultValue', 'attainment', 'budgetAmount']) assert.ok(k in got.body.data, k);
  assert.equal(JSON.stringify(got.body).includes(ids.personA), false, 'a consulta não expõe pessoas');
  for (const route of [`/marketing/campaigns/${id}/audience`, `/marketing/campaigns/${id}/export`, '/marketing/campaigns/export']) {
    const r = await call('gestorA', 'GET', route);
    assert.ok([404, 405].includes(r.status), `${route}: ${r.status}`);
  }

  // ciclo completo por HTTP: 34 visitas válidas, custo de 9.180,00 e o job de ciclo de vida no fim da campanha (relógio injetado)
  const [camp] = (await adminQuery('SELECT group_id, company_id, ends_at FROM marketing.campaigns WHERE id = $1', [id])).rows;
  for (let i = 0; i < 34; i += 1) {
    await adminQuery(`INSERT INTO marketing.attribution_events (group_id, company_id, person_id, campaign_id, event_type, touch_roles, evidence_json, valid, occurred_at)
      VALUES ($1, $2, $3, $4, 'VISIT', '{FIRST,LAST}', '{"fonte":"QA-M9 D412"}'::jsonb, true, $5)`, [camp.group_id, camp.company_id, ids.personA, id, new Date(new Date(camp.ends_at).getTime() - 3600e3)]);
  }
  // o custo real vem do Financeiro (M9-D432): despesa paga de R$ 9.180,00 ligada à campanha pela referência de origem
  const [cc] = (await adminQuery(`INSERT INTO finance.cost_centers (id, group_id, company_id, code, name) VALUES (gen_random_uuid(), $1, $2, $3, 'QA-M9 D412') RETURNING id`, [camp.group_id, camp.company_id, `QA-M9-${id.slice(0, 8)}`])).rows;
  await adminQuery(`INSERT INTO finance.financial_entries (id, group_id, company_id, cost_center_id, entry_type, nature, amount, status, settled_at, competence_month, origin_ref)
    VALUES (gen_random_uuid(), $1, $2, $3, 'DEBIT', 'PAYABLE', 9180, 'SETTLED', now(), '2031-12', $4)`, [camp.group_id, camp.company_id, cc.id, `campaign:${id}`]);
  const lifecycle = require('../src/features/marketing/campaigns').lifecycle;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: camp.group_id, c: camp.company_id }, transaction });
    await lifecycle.runLifecycleTick({ groupId: camp.group_id, companyId: camp.company_id }, transaction, new Date(new Date(camp.ends_at).getTime() + 1000));
  });
  const ended = await call('gestorA', 'GET', `/marketing/campaigns/${id}`);
  console.log('EVIDENCIA_D412 campanha encerrada:', JSON.stringify({ status: ended.body.data.status, resultValue: ended.body.data.resultValue, targetValue: ended.body.data.targetValue,
    attainment: ended.body.data.attainment, attainmentDisplay: ended.body.data.attainmentDisplay, costActual: ended.body.data.costActual, costPerResult: ended.body.data.costPerResult,
    steps: ended.body.data.steps.map((x) => x.status) }));
  assert.equal(ended.body.data.status, 'ENDED');
  assert.equal(ended.body.data.attainment, 0.85);
  assert.equal(ended.body.data.attainmentDisplay, '85,00%');
  assert.equal(ended.body.data.costPerResult, 270);
  assert.deepEqual(ended.body.data.steps.map((x) => x.status), ['CANCELLED']);
  const finalEdit = await call('gestorA', 'POST', '/marketing/campaigns', { campaignId: id, name: 'x' });
  assert.equal(finalEdit.status, 409);
  assert.equal(finalEdit.body.error.code, 'MKT_CAMPAIGN_FINAL');

  // isolamento: pessoa de outra empresa -> 422; a outra empresa não vê a campanha -> 404
  const cross = await call('gestorA', 'POST', '/marketing/campaigns', bodyOf({ audiences: [{ kind: 'PERSON_LIST', purpose: 'X', filter: { personIds: [ids.personB] } }], schedule: true }));
  console.log('EVIDENCIA_D412 audiencia de outra empresa:', cross.status, JSON.stringify(cross.body.error));
  assert.equal(cross.status, 422);
  assert.equal(cross.body.error.code, 'MKT_AUDIENCE_CROSS_COMPANY');
  const other = await call('gestorB', 'GET', `/marketing/campaigns/${id}`);
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'MKT_NOT_FOUND');
  assert.equal((await call('gestorA', 'GET', '/marketing/campaigns/nao-e-uuid')).status, 404);

  // teto de massa: 51 pessoas sem marketing:send:mass -> 403 (padrão 50)
  const many = [ids.personA];
  for (let i = 0; i < 51; i += 1) {
    many.push((await adminQuery(
      `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status)
       SELECT gen_random_uuid(), group_id, company_id, 'PF', 'QA-M9 D412', 'ACTIVE' FROM people.persons WHERE id = $1 RETURNING id`, [ids.personA])).rows[0].id);
  }
  const mass = await call('gestorA', 'POST', '/marketing/campaigns', bodyOf({ audiences: [{ kind: 'PERSON_LIST', purpose: 'M', filter: { personIds: many } }], schedule: true }));
  assert.equal(mass.status, 403, JSON.stringify(mass.body));
  assert.equal(mass.body.error.code, 'MKT_MASS_PERMISSION_REQUIRED');
});
