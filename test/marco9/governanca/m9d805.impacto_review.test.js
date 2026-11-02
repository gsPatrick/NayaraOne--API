'use strict';

// M9-D805 (reabertura C2) — GET /data-quality/queue/:id/impact em item de REVIEW responde 200 com contagens vazias e aviso
// próprio da consulta (nunca "Decisão inválida"); a decisão MERGED em REVIEW segue 400. Banco descartável (withDisposableDb.js).
process.env.PORT = process.env.M9D805_IMPACTO_TEST_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');
const { withTenantTransaction } = require('../../testHelpers');
const stewardship = require('../../../src/features/core-governance/data-quality/stewardship.service');
const detection = require('../../../src/features/core-governance/data-quality/merge.detection');

const MANAGED = ['governance:data-quality:read', 'governance:data-quality:manage'];
let baseUrl; let tenants; let appLoaded = false; let httpSkip = null; let token;

before(async () => {
  if (!DISPOSABLE) { httpSkip = SKIP_DISPOSABLE; return; }
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  if (!password) { httpSkip = 'seed de dois tenants ausente.'; return; }
  tenants = await loadTenants();
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
    WHERE r.name = 'CI GESTOR' AND p.code = ANY($1) AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id)`, [MANAGED]);
  await withTenantTransaction(tenants.A, (tx) => stewardship.designate(tenants.A, env.actorOf(tenants.A), 'PESSOAS', { designations: [{ role: 'STEWARD', userId: tenants.A.userId }] }, tx));
  require('../../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  let res; let body;
  for (let i = 0; i < 5; i += 1) {
    res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor('A', 'gestor'), password }) });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
  }
  assert.equal(res.status, 200, 'login gestor');
  token = body.data.accessToken;
});

after(async () => {
  if (appLoaded) {
    await require('../../../src/models').sequelize.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }
});

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('m9d805 /impact de item REVIEW responde 200 vazio com aviso; MERGED em REVIEW segue 400', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const review = await withTenantTransaction(tenants.A, async (tx) => {
    const person = await env.person(tenants.A, tx, { legalName: 'QA-M9 Revisao Impacto' });
    return detection.openReviewItem(tenants.A, { entityType: 'PERSON', entityId: person.id, reason: 'QUALITY_CRITICAL', score: 100 }, tx);
  });
  assert.equal(review.kind, 'REVIEW');
  const impact = await call('GET', `/data-quality/queue/${review.id}/impact`);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.deepEqual(impact.body.data.counts, {});
  assert.equal(impact.body.data.totalAmountCents, 0);
  assert.deepEqual(impact.body.data.blockers, []);
  assert.match(impact.body.data.notice, /revisão de qualidade/);
  assert.doesNotMatch(JSON.stringify(impact.body), /Decisão inválida/);
  const merged = await call('POST', `/data-quality/queue/${review.id}/decision`, { decision: 'MERGED', survivorId: review.primary_id });
  assert.ok([400, 403].includes(merged.status), String(merged.status));
  if (merged.status === 400) assert.equal(merged.body.error.code, 'GOV_QUEUE_DECISION_INVALID');
  const { rows: [after] } = await adminQuery('SELECT status FROM governance.review_queue_items WHERE id = $1', [review.id]);
  assert.equal(after.status, 'OPEN');
});

test('m9d805 /impact de par de cadastros segue com o corpo de união (sem aviso)', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const item = await withTenantTransaction(tenants.A, async (tx) => {
    const a = await env.person(tenants.A, tx, { legalName: 'QA-M9 Par Impacto' });
    const b = await env.person(tenants.A, tx, { legalName: 'QA-M9 Par Impacto' });
    return env.candidate(tenants.A, tx, 'PERSON', a.id, b.id);
  });
  const impact = await call('GET', `/data-quality/queue/${item.id}/impact?survivorId=${item.primary_id}`);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.equal(impact.body.data.notice, undefined);
  assert.equal(impact.body.data.record.label, 'Cadastro que será absorvido');
});
