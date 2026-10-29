'use strict';

// M9-D803 (reabertura) — visibilidade de GET /calendar por source_kind, pela API real, em banco descartável (nunca o .env remoto).
process.env.PORT = process.env.M9D803_HTTP_TEST_PORT || '21653';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID: uuid } = require('node:crypto');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants, cleanCalendar } = require('../../m9d801.helpers');

const ROLES = { maker: 'CI MAKER', leitura: 'CI LEITURA', gestor: 'CI GESTOR' };
// Combinações: maker = só legal:read; leitura = só construction:read; gestor = legal:read + construction:read.
const PERMISSIONS = { maker: ['legal:read'], leitura: ['construction:read'], gestor: ['legal:read', 'construction:read'] };
const MANAGED = ['legal:read', 'construction:read', 'governance:calendar:read'];
let baseUrl; let tenants; let appLoaded = false; let httpSkip = null;
const tokens = {};

async function setPermissions(role, codes) {
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)`, [role, MANAGED]);
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, [role, codes]);
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password || !(await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  for (const [profile, role] of Object.entries(ROLES)) await setPermissions(role, [...PERMISSIONS[profile], 'governance:calendar:read']);
  await cleanCalendar([tenants.A]);
  require('../../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const profile of Object.keys(ROLES)) {
    let res; let body;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', profile), password }) });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${profile}`);
    tokens[profile] = body.data.accessToken;
  }
});

after(async () => {
  if (DISPOSABLE && tenants) {
    await cleanCalendar([tenants.A]);
    await setPermissions(ROLES.maker, ['legal:read', 'governance:calendar:read']);
    await setPermissions(ROLES.leitura, ['governance:calendar:read']);
    await setPermissions(ROLES.gestor, ['legal:read']);
  }
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

async function insertKind(sourceType, sourceKind, title, dueAt = '2026-11-05T15:00:00Z') {
  await adminQuery(
    `INSERT INTO governance.calendar_items (group_id, company_id, source_type, source_id, title, due_at, severity, status, deep_link, source_kind)
     VALUES ($1,$2,$3,$4,$5,$6,'WARNING','OPEN','/painel/x',$7)`,
    [tenants.A.groupId, tenants.A.companyId, sourceType, uuid(), title, dueAt, sourceKind]
  );
}

const list = async (who, query = '') => {
  const res = await fetch(`${baseUrl}/calendar?from=2026-11-01&to=2026-11-30${query}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
};

test('m9d803 GET /calendar filtra GUARANTEE por source_kind: fiança exige legal:read, garantia de obra exige obras', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  await cleanCalendar([tenants.A]);
  await insertKind('GUARANTEE', 'LEGAL_GUARANTEE', 'QA-M9 fiança');
  await insertKind('GUARANTEE', 'WARRANTY_CASE', 'QA-M9 caso em garantia');
  await insertKind('GUARANTEE', 'PROJECT_WARRANTY', 'QA-M9 garantia da obra');
  await insertKind('CONSTRUCTION', 'STAGE', 'QA-M9 etapa');
  const kinds = async (who, query) => (await list(who, query)).data.map((i) => i.sourceKind).sort();
  assert.deepEqual(await kinds('maker'), ['LEGAL_GUARANTEE'], 'só legal:read: fiança, sem obra');
  assert.deepEqual(await kinds('leitura'), ['PROJECT_WARRANTY', 'STAGE', 'WARRANTY_CASE'], 'só construction:read: obra, sem fiança');
  assert.deepEqual(await kinds('gestor'), ['LEGAL_GUARANTEE', 'PROJECT_WARRANTY', 'STAGE', 'WARRANTY_CASE'], 'as duas permissões: tudo');
  const filtrado = await list('maker', '&sourceType=GUARANTEE');
  assert.deepEqual([filtrado.data.length, filtrado.pagination.total], [1, 1], 'o total também reflete a omissão');
  const obraSemJuridico = await list('leitura', '&sourceType=GUARANTEE');
  assert.deepEqual(obraSemJuridico.data.map((i) => i.title).sort(), ['QA-M9 caso em garantia', 'QA-M9 garantia da obra']);
});
