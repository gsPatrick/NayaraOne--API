'use strict';

// M9-D003 — Estrutura src/modules/ai, serviços, permissões ai:* e chave geral da NAY (ia.habilitada).
// Rodar SEMPRE em banco descartável (nunca no .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/ai/m9d003.estruturaPermissoesChave.test.js"
// Os testes de HTTP/banco são PULADOS com motivo explícito fora do cluster descartável; os estáticos rodam em qualquer lugar.

process.env.PORT = process.env.M9D003_HTTP_TEST_PORT || '21703';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const AI_DIR = path.join(__dirname, '..', '..', 'src', 'modules', 'ai');
const PASTAS = ['providers', 'agents', 'tools', 'retrieval', 'memory', 'evaluations', 'budgets', 'orchestrator', 'readmodels'];
const SERVICOS = ['AiOrchestrator', 'ToolRegistry', 'RetrievalService', 'MemoryService', 'ModelRouter', 'AiEvaluationService'];
const PERMISSOES = ['ai:use', 'ai:read', 'ai:audit', 'ai:approve', 'ai:admin', 'ai:budget', 'ai:evaluate', 'ai:restricted'];

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';

let baseUrl;
let appLoaded = false;
let httpSkip = DISPOSABLE ? null : SKIP;
const tokens = {};

async function adminQuery(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

before(async () => {
  if (!DISPOSABLE) return;
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../scripts/seed-ci-two-tenants');
  const seeded = password ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) { httpSkip = 'seed de dois tenants ausente.'; return; }

  // CI GESTOR (das duas empresas) recebe ai:use, ai:read, ai:admin e as permissões de configuração; CI LEITURA fica sem ai:*.
  await adminQuery(`
    INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now()
      FROM core.roles r CROSS JOIN core.permissions p
     WHERE r.name = 'CI GESTOR' AND p.code IN ('ai:use', 'ai:read', 'ai:admin', 'settings:read', 'settings:update')
       AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`);
  await adminQuery(`
    INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now()
      FROM core.roles r CROSS JOIN core.permissions p
     WHERE r.name = 'CI LEITURA' AND p.code IN ('settings:read', 'settings:update')
       AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`);
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI LEITURA' AND p.code LIKE 'ai:%'`);

  require('../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]) {
    let res; let body;
    for (let i = 0; i < 5; i += 1) {
      res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailFor(tenant, profile), password }),
      });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}`);
    tokens[`${tenant}:${profile}`] = body.data.accessToken;
  }
});

after(() => {
  if (appLoaded) setTimeout(() => process.exit(0), 300);
});

async function call(who, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('m9d003_rota_ai_sem_chave_ligada_503', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  // Padrão Desligado: ninguém ligou a chave na empresa A.
  const desligada = await call('A:gestor', 'POST', '/ai/runs', {});
  assert.equal(desligada.status, 503);
  assert.equal(desligada.body.error.code, 'AI_FEATURE_DISABLED');
  assert.equal(desligada.body.error.message, 'A NAY está desativada para esta empresa.');
  assert.equal((await call('A:gestor', 'GET', '/ai/status')).status, 503);

  // Sem ai:use a recusa é do requirePermission, ANTES do aiGate (nem 503 nem vazamento do estado da chave).
  const semPermissao = await call('A:leitura', 'POST', '/ai/runs', {});
  assert.equal(semPermissao.status, 403);
  assert.equal(semPermissao.body.error.code, 'PERMISSION_DENIED');
  assert.equal(semPermissao.body.error.details.required, 'ai:use');
  assert.equal((await call(null, 'POST', '/ai/runs', {})).status, 401);

  // Ligar exige ai:admin: CI LEITURA tem settings:update mas não tem ai:admin, então é recusado, e nada é gravado.
  const recusado = await call('A:leitura', 'PUT', '/settings/ia.habilitada', { value: true });
  assert.equal(recusado.status, 403);
  assert.equal(recusado.body.error.details.required, 'ai:admin');
  assert.equal((await call('A:gestor', 'GET', '/ai/status')).status, 503, 'a chave continua desligada');
});

test('m9d003_ligar_e_desligar_chave_audita_antes_e_depois', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const ligar = await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: true });
  assert.equal(ligar.status, 200, JSON.stringify(ligar.body));
  const ok = await call('A:gestor', 'GET', '/ai/status');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.habilitada, true);
  assert.equal((await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: false })).status, 200);
  assert.equal((await call('A:gestor', 'GET', '/ai/status')).status, 503);
  assert.equal((await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: 'sim' })).status, 400, 'tipo inválido fail-closed');

  const { rows } = await adminQuery(
    `SELECT before_json, after_json, user_id FROM audit.audit_log WHERE entity_type = 'TenantSetting' AND action IN ('settings.create','settings.update')
        AND (after_json->>'key') = 'ia.habilitada' ORDER BY occurred_at`
  );
  assert.ok(rows.length >= 2, `auditorias da chave: ${rows.length}`);
  assert.ok(rows[0].user_id, 'a auditoria registra o usuário');
  assert.equal(rows[0].before_json, null);
  assert.equal(rows[0].after_json.value, true);
  assert.equal(rows[1].before_json.value, true);
  assert.equal(rows[1].after_json.value, false);
});

test('m9d003_chave_por_agente', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  assert.equal((await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: true })).status, 200);
  try {
    // Padrão "*": todos os agentes; o gate passa (o conteúdo do chat é de M9-D004).
    const todos = await call('A:gestor', 'POST', '/ai/agents/FINANCE/chat', {});
    assert.notEqual(todos.status, 409);
    assert.notEqual(todos.status, 503);
    assert.equal((await call('A:gestor', 'PUT', '/settings/ai.agents.enabled', { value: 'CRM, LEGAL' })).status, 200);
    const off = await call('A:gestor', 'POST', '/ai/agents/FINANCE/chat', {});
    assert.equal(off.status, 409);
    assert.equal(off.body.error.code, 'AI_AGENT_DISABLED');
    assert.equal(off.body.error.message, 'Este agente está desativado.');
    const on = await call('A:gestor', 'POST', '/ai/agents/crm/chat', {});
    assert.notEqual(on.status, 409);
    assert.notEqual(on.status, 503);
  } finally {
    await call('A:gestor', 'PUT', '/settings/ai.agents.enabled', { value: '*' });
    await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: false });
  }
});

test('m9d003_empresa_b_nao_herda_chave_da_a', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  assert.equal((await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: true })).status, 200);
  try {
    assert.equal((await call('A:gestor', 'GET', '/ai/status')).status, 200);
    const b = await call('B:gestor', 'GET', '/ai/status');
    assert.equal(b.status, 503);
    assert.equal(b.body.error.code, 'AI_FEATURE_DISABLED');
  } finally {
    await call('A:gestor', 'PUT', '/settings/ia.habilitada', { value: false });
  }
});

test('m9d003_permissoes_ai_seedadas_e_grants_runtime', async (t) => {
  // Estático: o catálogo do código tem os 8 códigos e a migration os semeia com guarda do role.
  const catalogo = require('../../src/modules/ai/ai.permissions');
  assert.deepEqual(catalogo.AI_PERMISSIONS.map((p) => p.code).sort(), [...PERMISSOES].sort());
  const migrations = fs.readdirSync(path.join(__dirname, '..', '..', 'migrations')).filter((f) => /^20260101000700-.*seed.*ai.*permissions/.test(f) || /^20260101000700-/.test(f));
  assert.equal(migrations.length, 1, 'migration 700 das permissões ai:*');
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', migrations[0]), 'utf8');
  for (const code of PERMISSOES) assert.ok(sql.includes(`'${code}'`), `migration sem ${code}`);
  assert.match(sql, /pg_roles WHERE rolname = 'nayara_runtime'/, 'GRANT guardado por existência do role');

  if (httpSkip) return t.skip(httpSkip);
  const { rows } = await adminQuery(`SELECT code FROM core.permissions WHERE code LIKE 'ai:%' ORDER BY code`);
  assert.deepEqual(rows.map((r) => r.code).sort(), [...PERMISSOES].sort());
  const role = await adminQuery(`SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime'`);
  if (role.rowCount) {
    const grant = await adminQuery(`SELECT has_table_privilege('nayara_runtime', 'core.permissions', 'SELECT') AS ok`);
    assert.equal(grant.rows[0].ok, true);
  }
  // ADMIN recebe 7 das 8 (ai:restricted só por concessão explícita, DI-300); perfis comuns não recebem nenhuma. O seed de CI não cria
  // perfil ADMIN: cria-se um na empresa A e reexecuta-se a migration (idempotente) para provar a concessão.
  const company = await adminQuery(`SELECT group_id, id FROM core.companies ORDER BY created_at LIMIT 1`);
  await adminQuery(`INSERT INTO core.roles (id, group_id, company_id, name, description, is_system, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ADMIN', 'Perfil ADMIN de prova (teste m9d003).', true, now(), now())`, [company.rows[0].group_id, company.rows[0].id]);
  const { Sequelize } = require('sequelize');
  const seq = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  try {
    await require('../../migrations/20260101000700-seed-and-grant-ai-permissions').up(seq.getQueryInterface());
    await require('../../migrations/20260101000700-seed-and-grant-ai-permissions').up(seq.getQueryInterface()); // idempotente
  } finally { await seq.close(); }
  const admin = await adminQuery(`SELECT p.code, rp.role_id, count(*)::int AS n FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id
      JOIN core.permissions p ON p.id = rp.permission_id WHERE r.name = 'ADMIN' AND p.code LIKE 'ai:%' GROUP BY p.code, rp.role_id`);
  assert.deepEqual([...new Set(admin.rows.map((r) => r.code))].sort(), PERMISSOES.filter((c) => c !== 'ai:restricted').sort());
  assert.ok(admin.rows.every((r) => r.n === 1), 'sem duplicata ao reexecutar');
  const comuns = await adminQuery(`SELECT count(*)::int AS n FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id
      JOIN core.permissions p ON p.id = rp.permission_id WHERE r.name = 'CI LEITURA' AND p.code LIKE 'ai:%'`);
  assert.equal(comuns.rows[0].n, 0);
});

test('m9d003_estrutura_de_pastas_e_servicos_exportados', () => {
  for (const pasta of PASTAS) {
    assert.ok(fs.statSync(path.join(AI_DIR, pasta)).isDirectory(), `falta src/modules/ai/${pasta}/`);
    assert.ok(fs.existsSync(path.join(AI_DIR, pasta, 'index.js')), `falta ${pasta}/index.js`);
  }
  assert.ok(fs.existsSync(path.join(AI_DIR, 'ai.routes.js')));
  const ai = require('../../src/modules/ai');
  for (const nome of SERVICOS) {
    assert.equal(typeof ai[nome], 'function', `${nome} não exportado`);
    const instancia = new ai[nome]();
    assert.equal(instancia.nome, nome);
  }
  assert.equal(typeof ai.router, 'function');
  assert.equal(typeof ai.aiGate, 'function');
});

test('m9d003_parametros_no_schema_e_padrao_desligado', () => {
  const { SETTINGS_SCHEMA } = require('../../src/features/settings/settings.service');
  assert.deepEqual(SETTINGS_SCHEMA['ia.habilitada'], { type: 'boolean' });
  assert.deepEqual(SETTINGS_SCHEMA['ai.agents.enabled'], { type: 'string' });
  const { AI_SETTING_DEFAULTS } = require('../../src/modules/ai/ai.settings');
  assert.equal(AI_SETTING_DEFAULTS['ia.habilitada'], false);
  assert.equal(AI_SETTING_DEFAULTS['ai.agents.enabled'], '*');
});
