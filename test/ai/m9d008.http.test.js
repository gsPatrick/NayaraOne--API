'use strict';

// M9-D008 — rotas /v1/ai/knowledge: ciclo cadastrar, homologar por outra pessoa, versionar, revogar; permissões, secret e isolamento.
// Só roda no cluster descartável (login real dos usuários do seed de dois tenants; nunca chama MFA nem forja token).

process.env.PORT = process.env.M9D008_HTTP_TEST_PORT || '21708';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = DISPOSABLE ? false : 'precisa do cluster descartável (node scripts/withDisposableDb.js)';
const tokens = {};
const emails = {};
let baseUrl;
let appLoaded = false;

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
  // GESTOR escreve (ai:admin), CHECKER homologa (ai:admin, outra pessoa), LEITURA só usa a NAY (ai:use, sem ai:admin).
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  await grant('CI CHECKER', ['ai:admin', 'ai:use']);
  await grant('CI LEITURA', ['ai:use']);
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
});

after(async () => {
  if (!appLoaded) return;
  for (const tenant of ['A', 'B']) await call('PUT', '/settings/ia.habilitada', tokens[`${tenant}:gestor`], { value: false });
  setTimeout(() => process.exit(0), 300);
});

// factKey único por execução: o teste grava com commit (HTTP real) e precisa ser repetível no mesmo banco.
const FK = `politica.desconto.http.${require('node:crypto').randomUUID().slice(0, 8)}`;
const NOVA = { factKey: FK, subjectType: 'politica', title: 'Desconto máximo', value: { percentual: 5 }, classification: 'INTERNAL' };

test('m9d008_http_ciclo_cadastrar_homologar_versionar_revogar', { skip: SKIP }, async () => {
  const criada = await call('POST', '/ai/knowledge', tokens['A:gestor'], NOVA);
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  assert.equal(criada.body.data.status, 'DRAFT'); assert.equal(criada.body.data.version, 1);
  const id1 = criada.body.data.id;
  const proprio = await call('POST', `/ai/knowledge/${id1}/homologate`, tokens['A:gestor']);
  assert.equal(proprio.status, 403); assert.equal(proprio.body.error.code, 'AI_KNOWLEDGE_SELF_HOMOLOGATION');
  assert.match(proprio.body.error.message, /Quem escreveu não pode homologar/);
  const editado = await call('PATCH', `/ai/knowledge/${id1}`, tokens['A:gestor'], { title: 'Desconto máximo (revisado)' });
  assert.equal(editado.status, 200, JSON.stringify(editado.body));
  const homolog = await call('POST', `/ai/knowledge/${id1}/homologate`, tokens['A:checker']);
  assert.equal(homolog.status, 200, JSON.stringify(homolog.body)); assert.equal(homolog.body.data.status, 'HOMOLOGATED');
  const edicao = await call('PATCH', `/ai/knowledge/${id1}`, tokens['A:gestor'], { title: 'Outra' });
  assert.equal(edicao.status, 409); assert.equal(edicao.body.error.code, 'AI_KNOWLEDGE_IMMUTABLE');
  assert.match(edicao.body.error.message, /crie uma nova versão/);

  const v2 = await call('POST', '/ai/knowledge', tokens['A:gestor'], { ...NOVA, value: { percentual: 7 } });
  assert.equal(v2.status, 201); assert.equal(v2.body.data.version, 2);
  assert.equal((await call('POST', `/ai/knowledge/${v2.body.data.id}/homologate`, tokens['A:checker'])).status, 200);
  const historico = await call('GET', `/ai/knowledge?factKey=${FK}`, tokens['A:gestor']);
  assert.deepEqual(historico.body.data.map((e) => [e.version, e.status]), [[2, 'HOMOLOGATED'], [1, 'SUPERSEDED']]);

  const semMotivo = await call('POST', `/ai/knowledge/${v2.body.data.id}/revoke`, tokens['A:gestor'], {});
  assert.equal(semMotivo.status, 400);
  const revoga = await call('POST', `/ai/knowledge/${v2.body.data.id}/revoke`, tokens['A:gestor'], { reason: 'norma mudou' });
  assert.equal(revoga.status, 200, JSON.stringify(revoga.body)); assert.equal(revoga.body.data.status, 'REVOKED');
  const outra = await call('POST', `/ai/knowledge/${v2.body.data.id}/revoke`, tokens['A:gestor'], { reason: 'de novo' });
  assert.equal(outra.status, 409); assert.equal(outra.body.error.code, 'AI_KNOWLEDGE_TRANSITION');
  const linhas = await admin('SELECT version, status, revoke_reason FROM ai.knowledge_entries WHERE fact_key = $1 ORDER BY version', [FK]);
  console.log(`# historico SQL: ${JSON.stringify(linhas.rows)}`);
  assert.deepEqual(linhas.rows.map((l) => l.status), ['SUPERSEDED', 'REVOKED']);
});

test('m9d008_http_secret_permissao_e_empresa_b', { skip: SKIP }, async () => {
  const segredo = await call('POST', '/ai/knowledge', tokens['A:gestor'], { ...NOVA, factKey: 'politica.segredo', value: { chave: 'AKIAIOSFODNN7EXAMPLE' } });
  assert.equal(segredo.status, 400); assert.equal(segredo.body.error.code, 'AI_KNOWLEDGE_SECRET_DETECTED');
  const semClass = await call('POST', '/ai/knowledge', tokens['A:gestor'], { ...NOVA, factKey: 'politica.semclasse', classification: undefined });
  assert.equal(semClass.status, 400); assert.equal(semClass.body.error.code, 'AI_KNOWLEDGE_INVALID');
  const leitura = await call('GET', '/ai/knowledge', tokens['A:leitura']);
  assert.equal(leitura.status, 403); assert.equal(leitura.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await call('GET', '/ai/knowledge', undefined)).status, 401);
  const listaB = await call('GET', `/ai/knowledge?factKey=${FK}`, tokens['B:gestor']);
  assert.equal(listaB.status, 200); assert.deepEqual(listaB.body.data, []);
  const linhaA = await admin('SELECT id FROM ai.knowledge_entries WHERE fact_key = $1 AND version = 1', [FK]);
  const b = await call('GET', `/ai/knowledge/${linhaA.rows[0].id}`, tokens['B:gestor']);
  assert.equal(b.status, 404); assert.equal(b.body.error.code, 'AI_KNOWLEDGE_NOT_FOUND');
});

test('m9d008_http_update_direto_em_homologada_e_negado_pelo_banco', { skip: SKIP }, async () => {
  await assert.rejects(
    () => admin("UPDATE ai.knowledge_entries SET title = 'adulterado por SQL' WHERE fact_key = $1 AND status = 'SUPERSEDED'", [FK]),
    (err) => { console.log(`# SQL negado pelo gatilho: ${err.message}`); return /AI_KNOWLEDGE_IMMUTABLE/.test(err.message); }
  );
});
