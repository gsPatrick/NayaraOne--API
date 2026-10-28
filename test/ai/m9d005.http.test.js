'use strict';

// M9-D005 — GET /v1/ai/runs/:id: run com fontes, filtro por pessoa sem ai:audit, 404 entre empresas e UPDATE negado em run final.
// Só roda no cluster descartável (login real dos usuários do seed de dois tenants; nunca chama MFA nem forja token).

process.env.PORT = process.env.M9D005_HTTP_TEST_PORT || '21705';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = DISPOSABLE ? false : 'precisa do cluster descartável (node scripts/withDisposableDb.js)';
const tokens = {};
const emails = {};
let baseUrl;
let appLoaded = false;
const runId = crypto.randomUUID();

async function admin(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

async function grant(roleName, codes) {
  await admin(
    `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
     SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
      WHERE r.name = $1 AND p.code = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
    [roleName, codes]
  );
}

async function call(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  if (!DISPOSABLE) return;
  const { emailFor } = require('../../scripts/seed-ci-two-tenants');
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  // GESTOR cria o run (ai:read, o próprio), CHECKER audita (ai:audit), LEITURA lê só os próprios (ai:read).
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  await grant('CI CHECKER', ['ai:audit', 'ai:use']);
  await grant('CI LEITURA', ['ai:read', 'ai:use']);
  require('../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'checker'], ['A', 'leitura'], ['B', 'gestor']]) {
    let res; let data;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', }, body: JSON.stringify({ email: emailFor(tenant, profile), password }) });
      data = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}`);
    tokens[`${tenant}:${profile}`] = data.data.accessToken;
    emails[`${tenant}:${profile}`] = emailFor(tenant, profile);
  }
  for (const tenant of ['A', 'B']) {
    const on = await call('PUT', '/settings/ia.habilitada', tokens[`${tenant}:gestor`], { value: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
  }
  const dono = await admin('SELECT u.id, m.company_id, m.group_id FROM core.users u JOIN core.user_memberships m ON m.user_id = u.id WHERE u.email = $1 AND m.deleted_at IS NULL LIMIT 1', [emails['A:gestor']]);
  const { id: userId, company_id: companyId, group_id: groupId } = dono.rows[0];
  await admin(
    `INSERT INTO ai.ai_runs (id, group_id, company_id, user_id, agent_name, input_summary, status, provider_code, model_code, routing_path, tokens_in, tokens_out, cost_amount, grounding_status, finished_at)
     VALUES ($1, $2, $3, $4, 'NAY_COMERCIAL', 'pergunta', 'COMPLETED', 'sandbox', 'sandbox-small', 'SMALL_MODEL', 1200, 300, 0.021, 'GROUNDED', now())`,
    [runId, groupId, companyId, userId]
  );
});

after(async () => {
  if (!appLoaded) return;
  for (const tenant of ['A', 'B']) await call('PUT', '/settings/ia.habilitada', tokens[`${tenant}:gestor`], { value: false });
  setTimeout(() => process.exit(0), 300);
});

test('m9d005_http_get_run_com_fontes_do_proprio_dono', { skip: SKIP }, async () => {
  const r = await call('GET', `/ai/runs/${runId}`, tokens['A:gestor']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const run = r.body.data;
  assert.equal(run.status, 'COMPLETED'); assert.equal(run.providerCode, 'sandbox'); assert.equal(run.modelCode, 'sandbox-small');
  assert.equal(run.costAmount, '0.021000'); assert.equal(run.routingPath, 'SMALL_MODEL'); assert.ok(Array.isArray(run.sources));
  console.log(`# GET /v1/ai/runs/:id => ${JSON.stringify({ status: run.status, costAmount: run.costAmount, providerCode: run.providerCode, fontes: run.sources.length })}`);
});

test('m9d005_http_outra_pessoa_sem_audit_404_e_auditor_200_e_empresa_b_404', { skip: SKIP }, async () => {
  const outra = await call('GET', `/ai/runs/${runId}`, tokens['A:leitura']);
  assert.equal(outra.status, 404); assert.equal(outra.body.error.code, 'AI_RUN_NOT_FOUND');
  const auditor = await call('GET', `/ai/runs/${runId}`, tokens['A:checker']);
  assert.equal(auditor.status, 200);
  const b = await call('GET', `/ai/runs/${runId}`, tokens['B:gestor']);
  assert.equal(b.status, 404); assert.equal(b.body.error.code, 'AI_RUN_NOT_FOUND');
  assert.equal((await call('GET', '/ai/runs/nao-e-uuid', tokens['A:gestor'])).status, 404);
  assert.equal((await call('GET', `/ai/runs/${runId}`, undefined)).status, 401);
});

test('m9d005_http_update_direto_em_run_final_e_negado_pelo_banco', { skip: SKIP }, async () => {
  // Nem o superusuário do cluster contorna: o gatilho vale para qualquer papel.
  await assert.rejects(
    () => admin("UPDATE ai.ai_runs SET output_summary = 'adulterado por SQL' WHERE id = $1", [runId]),
    (err) => { console.log(`# SQL negado pelo gatilho: ${err.message}`); return /AI_RUN_IMMUTABLE/.test(err.message); }
  );
  await assert.rejects(() => admin('DELETE FROM ai.ai_runs WHERE id = $1', [runId]), /AI_RUN_IMMUTABLE/);
});
