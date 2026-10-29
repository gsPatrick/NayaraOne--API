'use strict';

// M9-D805 — GET /data-quality/queue, GET .../impact e POST .../decision pela API real, mais o job noturno. Banco descartável (nunca o .env remoto):
// os dados são criados com commit e o cluster é apagado ao final. Nunca chama endpoint de MFA: a recusa MFA_* da união é o que se prova.
process.env.PORT = process.env.M9D805_HTTP_TEST_PORT || '21655';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');
const { withTenantTransaction } = require('../../testHelpers');
const stewardship = require('../../../src/features/core-governance/data-quality/stewardship.service');

const ROLES = { gestor: 'CI GESTOR', leitura: 'CI LEITURA' };
const MANAGED = ['governance:data-quality:read', 'governance:data-quality:manage'];
let baseUrl; let tenants; let appLoaded = false; let httpSkip = null;
const tokens = {};

async function setPermissions(role, codes) {
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)`, [role, MANAGED]);
  if (!codes.length) return;
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, [role, codes]);
}

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  await setPermissions(ROLES.gestor, MANAGED);
  await setPermissions(ROLES.leitura, ['governance:data-quality:read']);
  await withTenantTransaction(tenants.A, (tx) => stewardship.designate(tenants.A, env.actorOf(tenants.A), 'PESSOAS', { designations: [{ role: 'STEWARD', userId: tenants.A.userId }] }, tx));
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
  if (DISPOSABLE && tenants) await setPermissions(ROLES.gestor, MANAGED);
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const call = async (who, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

async function committedPair(extra = {}) {
  return withTenantTransaction(tenants.A, async (tx) => {
    const first = await env.person(tenants.A, tx, { legalName: 'QA-M9 Duplicada Http', ...extra });
    const second = await env.person(tenants.A, tx, { legalName: 'QA-M9 Duplicada Http' });
    const item = await env.candidate(tenants.A, tx, 'PERSON', first.id, second.id);
    return { first, second, item };
  });
}

test('m9d805 GET /data-quality/queue lista a fila e respeita a permissão de leitura', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { item } = await committedPair();
  const list = await call('leitura', 'GET', '/data-quality/queue?status=OPEN&entityType=PERSON&limit=200');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.items.some((i) => i.id === item.id && i.score === 100 && i.status === 'OPEN'));
  assert.equal(list.body.data.limit, 200);
});

test('m9d805 POST decision: 403 sem permissão, 200 do steward, 409 ao repetir', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { item } = await committedPair();
  const denied = await call('leitura', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'DISMISSED' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.body.error.details.required, 'governance:data-quality:manage');
  const bad = await call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'TALVEZ' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_QUEUE_DECISION_INVALID']);
  const ok = await call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'KEPT_SEPARATE', note: 'Pessoas diferentes.' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.status, ok.body.data.decidedBy], ['KEPT_SEPARATE', tenants.A.userId]);
  const again = await call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'DISMISSED' });
  assert.deepEqual([again.status, again.body.error.code, again.body.error.message], [409, 'GOV_QUEUE_ITEM_FINAL', 'Este item já foi decidido.']);
});

test('m9d805 unir cadastros exige MFA recente (linha 8 da M9-D852) e nada é gravado sem ele', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { item, first, second } = await committedPair();
  const merged = await call('gestor', 'POST', `/data-quality/queue/${item.id}/decision`, { decision: 'MERGED', survivorId: item.primary_id });
  assert.equal(merged.status, 403);
  assert.ok(['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED'].includes(merged.body.error.code), merged.body.error.code);
  const { rows } = await adminQuery('SELECT status FROM people.persons WHERE id = ANY($1)', [[first.id, second.id]]);
  assert.deepEqual(rows.map((r) => r.status), ['ACTIVE', 'ACTIVE']);
  const { rows: [after] } = await adminQuery('SELECT status FROM governance.review_queue_items WHERE id = $1', [item.id]);
  assert.equal(after.status, 'OPEN');
});

test('m9d805 GET .../impact devolve counts, totalAmountCents e blockers', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { item, first, second } = await committedPair({ taxIdNormalized: env.cpf() });
  await withTenantTransaction(tenants.A, async (tx) => {
    const out = item.primary_id === first.id ? second.id : first.id;
    await env.feedbackCase(tenants.A, tx, out);
    await env.query('UPDATE people.persons SET tax_id_normalized = :cpf WHERE id = :id', { cpf: env.cpf(), id: out }, tx);
  });
  const impact = await call('leitura', 'GET', `/data-quality/queue/${item.id}/impact?survivorId=${item.primary_id}`);
  assert.equal(impact.status, 200);
  assert.equal(impact.body.data.counts['crm.feedback_cases.person_id'], 1);
  assert.equal(impact.body.data.totalAmountCents, 0);
  const bothTaxIds = (await adminQuery('SELECT count(*)::int AS n FROM people.persons WHERE id = ANY($1) AND tax_id_normalized IS NOT NULL', [[first.id, second.id]])).rows[0].n === 2;
  if (bothTaxIds) assert.deepEqual(impact.body.data.blockers.map((b) => b.code), ['PERSON_MERGE_CONFLICT']);
  const outside = await call('leitura', 'GET', `/data-quality/queue/${item.id}/impact?survivorId=${env.randomUUID()}`);
  assert.deepEqual([outside.status, outside.body.error.code], [400, 'GOV_MERGE_SURVIVOR_INVALID']);
});

test('m9d805 o job noturno enfileira duplicidades e é idempotente', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { runDataQualityMergeDetectionJob } = require('../../../src/engines/jobs/dataQualityMergeDetectionJob');
  const cpf = env.cpf();
  const ids = await withTenantTransaction(tenants.A, async (tx) => {
    const a = await env.person(tenants.A, tx, { taxIdNormalized: cpf });
    const b = await env.person(tenants.A, tx, { taxIdNormalized: `${cpf}-` });
    return [a.id, b.id];
  });
  const quiet = await runDataQualityMergeDetectionJob(new Date('2026-10-29T12:00:00Z'));
  assert.equal(quiet.ran, 0, 'fora da hora configurada o job não roda');
  const first = await runDataQualityMergeDetectionJob(new Date(), { force: true });
  assert.equal(first.errors, 0);
  const count = async () => (await adminQuery('SELECT count(*)::int AS n FROM governance.review_queue_items WHERE primary_id = ANY($1) AND secondary_id = ANY($1)', [ids])).rows[0].n;
  assert.equal(await count(), 1);
  await runDataQualityMergeDetectionJob(new Date(), { force: true });
  assert.equal(await count(), 1, 'rodar de novo não duplica');
});
