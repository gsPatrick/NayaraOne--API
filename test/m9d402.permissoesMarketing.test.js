'use strict';

// M9-D402 — Permissões marketing:*, estrutura src/modules/marketing e padrão de erro MKT_*.
//
// Rodar SEMPRE em banco descartável (nunca no .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d402.permissoesMarketing.test.js"
// Os testes estáticos (pastas, imports, catálogo) rodam em qualquer lugar; os que precisam de banco/HTTP são pulados
// com motivo explícito fora do cluster descartável.

process.env.PORT = process.env.M9D402_HTTP_TEST_PORT || '21652';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const API_ROOT = path.join(__dirname, '..');
const MKT_DIR = path.join(API_ROOT, 'src', 'modules', 'marketing');
const MIGRATION_FILE = '20260101000760-marketing-permissions-and-roles.js';

const AREAS = ['content', 'campaigns', 'automations', 'publications', 'tracking', 'suppression'];
const PERMISSIONS_12 = [
  'marketing:content:read', 'marketing:content:write', 'marketing:content:approve', 'marketing:content:publish',
  'marketing:template:manage', 'marketing:campaign:manage', 'marketing:automation:manage', 'marketing:automation:publish',
  'marketing:suppression:manage', 'marketing:send:mass', 'marketing:attribution:read', 'marketing:killswitch:manage',
];
const ASSISTENTE = ['marketing:content:read', 'marketing:content:write'];
const GERENTE = [
  ...ASSISTENTE, 'marketing:content:approve', 'marketing:content:publish', 'marketing:campaign:manage',
  'marketing:automation:manage', 'marketing:automation:publish',
];
const DIRETORIA = [...GERENTE, 'marketing:killswitch:manage'];

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP_DISPOSABLE = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';

let adminSequelize;
let sequelize;
let baseUrl;
let appLoaded = false;
let httpSkip = null;
let tenantA;
const tokens = {};
const users = {};
const originalRoles = {};

async function adminQuery(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function login(label, tenantKey, profile) {
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  let res; let body;
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailFor(tenantKey, profile), password: process.env.CI_TENANT_USERS_PASSWORD }),
    });
    body = await res.json();
    if (res.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * (tentativa + 1)));
  }
  assert.equal(res.status, 200, `login ${label}: ${JSON.stringify(body)}`);
  tokens[label] = body.data.accessToken;
}

async function setMembershipRole(email, roleName) {
  await adminQuery(
    `UPDATE core.user_memberships m SET role_id = r.id
       FROM core.users u, core.roles r
      WHERE m.user_id = u.id AND u.email = $1 AND r.company_id = m.company_id AND r.name = $2 AND r.deleted_at IS NULL`,
    [email, roleName]
  );
}

before(async () => {
  if (!DISPOSABLE) {
    httpSkip = SKIP_DISPOSABLE;
    return;
  }
  ({ sequelize } = require('../src/models'));
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const seeded = password ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) {
    httpSkip = 'seed de dois tenants ausente (scripts/seed-ci-two-tenants.js com CI_TENANT_USERS_PASSWORD).';
    return;
  }
  const row = (await adminQuery(
    `SELECT m.user_id, m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1`,
    [emailFor('A', 'gestor')]
  )).rows[0];
  tenantA = { groupId: row.group_id, companyId: row.company_id, userId: row.user_id };
  users.gestor = row.user_id;

  // Cria os 3 papéis e concede o padrão (idempotente) pelo serviço real, numa transação com a empresa A.
  const { aplicarConcessaoPadrao } = require('../src/modules/marketing/marketing.permissions');
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    await aplicarConcessaoPadrao(tenantA, tenantA.userId, transaction);
  });

  // O usuário "gestor" ganha credencial MFA habilitada SEM step-up recente (users.mfa_enabled continua falso: o login não
  // pede código; nenhum endpoint de MFA é chamado). Serve para provar MFA_STEP_UP_REQUIRED na reativação.
  const { encryptSecret } = require('../src/utils/mfaCrypto');
  await adminQuery(
    `INSERT INTO core.mfa_credentials (id, user_id, group_id, company_id, secret_encrypted, enabled, confirmed_at, recovery_codes_hash, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, true, now(), '{}', now(), now())
     ON CONFLICT (user_id) DO NOTHING`,
    [tenantA.userId, tenantA.groupId, tenantA.companyId, encryptSecret('JBSWY3DPEHPK3PXP')]
  );

  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Papéis originais, devolvidos no after() para não contaminar os demais arquivos que usam o mesmo seed.
  originalRoles.leitura = 'CI LEITURA';
  originalRoles.gestor = 'CI GESTOR';
  await setMembershipRole(emailFor('A', 'leitura'), 'Assistente de Marketing');
  await setMembershipRole(emailFor('A', 'gestor'), 'Gerente de Marketing');
  await login('assistente', 'A', 'leitura');
  await login('gerente', 'A', 'gestor');
  await setMembershipRole(emailFor('A', 'gestor'), 'Diretoria');
  await login('diretoria', 'A', 'gestor');
});

after(async () => {
  if (DISPOSABLE && originalRoles.leitura) {
    const { emailFor } = require('../scripts/seed-ci-two-tenants');
    await setMembershipRole(emailFor('A', 'leitura'), originalRoles.leitura).catch(() => {});
    await setMembershipRole(emailFor('A', 'gestor'), originalRoles.gestor).catch(() => {});
  }
  if (adminSequelize) await adminSequelize.close().catch(() => {});
  if (sequelize) await sequelize.close().catch(() => {});
  if (appLoaded) setTimeout(() => process.exit(0), 300);
});

async function call(who, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), correlation: res.headers.get('x-correlation-id') };
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('m9d402 estrutura de pastas igual ao Guia §2 (6 áreas, cada uma com service, controller, routes e index)', () => {
  const dirs = fs.readdirSync(MKT_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, [...AREAS].sort());
  for (const area of AREAS) {
    const files = fs.readdirSync(path.join(MKT_DIR, area));
    for (const required of ['index.js', `${area}.service.js`, `${area}.controller.js`, `${area}.routes.js`]) {
      assert.ok(files.includes(required), `${area} sem ${required}`);
    }
    const mod = require(path.join(MKT_DIR, area));
    assert.equal(typeof mod.router, 'function', `${area}/index.js deve exportar router`);
    assert.equal(typeof mod.service, 'object', `${area}/index.js deve exportar service`);
  }
});

test('m9d402 modulo_nao_tem_import_circular: nenhuma área importa outra por caminho interno e o grafo de requires não tem ciclo', () => {
  const files = listJsFiles(MKT_DIR);
  const graph = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const deps = [];
    for (const m of text.matchAll(/require\('(\.[^']+)'\)/g)) {
      const resolved = require.resolve(path.resolve(path.dirname(file), m[1]));
      if (resolved.startsWith(MKT_DIR)) deps.push(resolved);
      const ownArea = AREAS.find((a) => file.startsWith(path.join(MKT_DIR, a) + path.sep));
      const targetArea = AREAS.find((a) => resolved.startsWith(path.join(MKT_DIR, a) + path.sep));
      if (ownArea && targetArea && ownArea !== targetArea) {
        assert.equal(path.basename(resolved), 'index.js', `${path.relative(API_ROOT, file)} importa ${m[1]} por caminho interno de outra área`);
      }
    }
    graph.set(file, deps);
  }
  const state = new Map();
  const visit = (node, trail) => {
    if (state.get(node) === 2) return;
    assert.notEqual(state.get(node), 1, `import circular: ${[...trail, node].map((f) => path.relative(MKT_DIR, f)).join(' -> ')}`);
    state.set(node, 1);
    for (const dep of graph.get(node) || []) visit(dep, [...trail, node]);
    state.set(node, 2);
  };
  for (const file of graph.keys()) visit(file, []);
  // E o módulo carrega por inteiro.
  assert.equal(typeof require(MKT_DIR).router, 'function');
});

test('m9d402 catálogo de 12 permissões, papéis e erro MKT_*: o código e a migration coincidem', () => {
  const perms = require('../src/modules/marketing/marketing.permissions');
  assert.deepEqual(perms.MARKETING_PERMISSIONS.map((p) => p.code), PERMISSIONS_12);
  assert.deepEqual([...perms.DEFAULT_GRANTS.ASSISTENTE].sort(), [...ASSISTENTE].sort());
  assert.deepEqual([...perms.DEFAULT_GRANTS.GERENTE].sort(), [...GERENTE].sort());
  assert.deepEqual([...perms.DEFAULT_GRANTS.DIRETORIA].sort(), [...DIRETORIA].sort());
  assert.deepEqual([...perms.DEFAULT_GRANTS.ADMIN].sort(), [...PERMISSIONS_12].sort());
  // Assistente (write) não tem approve nem publish; ninguém além da Diretoria/ADMIN tem killswitch.
  assert.ok(!perms.DEFAULT_GRANTS.ASSISTENTE.includes('marketing:content:approve'));
  assert.ok(!perms.DEFAULT_GRANTS.GERENTE.includes('marketing:killswitch:manage'));

  const migration = require(path.join(API_ROOT, 'migrations', MIGRATION_FILE));
  assert.deepEqual(migration.PERMISSIONS.map(([code]) => code), PERMISSIONS_12, 'a migration grava as mesmas 12 permissões');
  const migrationText = fs.readFileSync(path.join(API_ROOT, 'migrations', MIGRATION_FILE), 'utf8');
  assert.doesNotMatch(migrationText.replace(/\/\*[\s\S]*?\*\//g, ''), /\bGRANT\b|CREATE TABLE|nayara_runtime/, 'a migration só grava permissões, papéis e concessões: sem tabela nem GRANT');

  const errors = require('../src/modules/marketing/marketing.errors');
  const forbidden = errors.mktForbidden();
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.code, 'MKT_FORBIDDEN');
  assert.equal(forbidden.message, 'Você não tem permissão para esta ação de Marketing.');
  assert.throws(() => errors.mktError(400, 'SEM_PREFIXO', 'x'), /prefixo MKT_/);
});

test('m9d402 parâmetros de massa e de perfis estão no SETTINGS_SCHEMA com o padrão do catálogo e são lidos por código', async () => {
  const settings = require('../src/modules/marketing/marketing.settings');
  assert.equal(settings.MARKETING_SETTING_DEFAULTS['marketing.mass.max_recipients_sem_aprovacao'], 50);
  assert.equal(settings.MARKETING_SETTING_DEFAULTS['marketing.mass.max_recipients_absoluto'], 5000);
  const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
  for (const key of Object.keys(settings.MARKETING_SETTINGS_SCHEMA)) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} fora do SETTINGS_SCHEMA`);
    assert.ok(settings.MARKETING_SETTING_DEFAULTS[key] !== undefined, `${key} sem padrão`);
  }
  // Parâmetro declarado e não lido é defeito: cada chave aparece num getSetting do módulo.
  const code = listJsFiles(MKT_DIR).filter((f) => !f.endsWith('marketing.settings.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const key of Object.keys(settings.MARKETING_SETTINGS_SCHEMA)) {
    const constName = Object.entries(settings).find(([, v]) => v === key)?.[0];
    assert.ok(code.includes(key) || (constName && code.includes(constName)), `${key} declarado e nunca lido`);
  }
});

test('m9d402 mass_messaging: a permissão send:mass e o guarda que lê os dois tetos existem (regra completa e recusas: M9-D433)', { skip: !DISPOSABLE && SKIP_DISPOSABLE }, async () => {
  const { assertMassSendAllowed } = require('../src/modules/marketing/marketing.guards');
  const run = (count, permissions) => sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    return assertMassSendAllowed({ recipients: count, permissions, tenant: tenantA, transaction });
  });
  await run(50, []); // no teto sem aprovação: livre
  await assert.rejects(() => run(51, ['marketing:content:read']), (e) => e.statusCode === 403 && e.code === 'MKT_MASS_PERMISSION_REQUIRED');
  await run(51, ['marketing:send:mass']);
  await run(5000, ['marketing:send:mass']);
  await assert.rejects(() => run(5001, ['marketing:send:mass']), (e) => e.statusCode === 422 && e.code === 'MKT_MASS_LIMIT_EXCEEDED');
});

test('m9d402 permissoes_marketing_existem_e_estao_nos_papeis (banco: migration + concessão padrão idempotente)', { skip: !DISPOSABLE && SKIP_DISPOSABLE }, async () => {
  if (httpSkip) return;
  const got = (await adminQuery('SELECT code FROM core.permissions WHERE code LIKE $1 ORDER BY code', ['marketing:%'])).rows.map((r) => r.code);
  assert.deepEqual(got, [...PERMISSIONS_12].sort());
  const grantsOf = async (roleName) => (await adminQuery(
    `SELECT p.code FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE r.company_id = $1 AND r.name = $2 AND p.code LIKE 'marketing:%' ORDER BY p.code`,
    [tenantA.companyId, roleName]
  )).rows.map((r) => r.code);
  assert.deepEqual(await grantsOf('Assistente de Marketing'), [...ASSISTENTE].sort());
  assert.deepEqual(await grantsOf('Gerente de Marketing'), [...GERENTE].sort());
  assert.deepEqual(await grantsOf('Diretoria'), [...DIRETORIA].sort());

  // Idempotente: reaplicar não duplica papel nem concessão.
  const { aplicarConcessaoPadrao } = require('../src/modules/marketing/marketing.permissions');
  const result = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    return aplicarConcessaoPadrao(tenantA, tenantA.userId, transaction);
  });
  assert.equal(result.concedidas, 0);
  assert.equal((await adminQuery(`SELECT count(*)::int AS n FROM core.roles WHERE company_id = $1 AND name = 'Diretoria' AND deleted_at IS NULL`, [tenantA.companyId])).rows[0].n, 1);
  // Auditoria da concessão (antes e depois) existe pelo módulo de auditoria.
  const audit = await adminQuery(`SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'marketing.permissions.default_grants' AND company_id = $1`, [tenantA.companyId]);
  assert.ok(audit.rows[0].n >= 3);
});

test('m9d402 assistente_nao_aprova: Assistente recebe 403 MKT_FORBIDDEN em approve; Gerente passa pela permissão; correlation_id devolvido', { skip: !DISPOSABLE && SKIP_DISPOSABLE }, async () => {
  if (httpSkip) return;
  const id = '00000000-0000-4000-8000-000000000402';
  const denied = await call('assistente', 'POST', `/marketing/content/${id}/approve`, { decision: 'APPROVE' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'MKT_FORBIDDEN');
  assert.equal(denied.body.error.message, 'Você não tem permissão para esta ação de Marketing.');
  assert.ok(denied.correlation, 'resposta traz X-Correlation-Id');
  assert.equal(JSON.stringify(denied.body).includes('stack'), false);
  const ok = await call('gerente', 'POST', `/marketing/content/${id}/approve`, { decision: 'APPROVE' });
  assert.notEqual(ok.body?.error?.code, 'MKT_FORBIDDEN', 'o Gerente tem content:approve');
  assert.notEqual(ok.status, 403);
  // Assistente lê e escreve conteúdo (read/write), mas não publica nem liga o kill switch.
  const publish = await call('assistente', 'POST', `/marketing/content/${id}/schedule`, {});
  assert.equal(publish.body.error.code, 'MKT_FORBIDDEN');
  const kill = await call('assistente', 'POST', '/marketing/kill-switch', { scope: 'GLOBAL', active: true, reason: 'teste de permissão' });
  assert.equal(kill.status, 403);
  assert.equal(kill.body.error.code, 'MKT_FORBIDDEN');
  const gerenteKill = await call('gerente', 'POST', '/marketing/kill-switch', { scope: 'GLOBAL', active: true, reason: 'teste de permissão' });
  assert.equal(gerenteKill.body.error.code, 'MKT_FORBIDDEN', 'Gerente não tem killswitch:manage');
  const noAuth = await call(null, 'POST', `/marketing/content/${id}/approve`, {});
  assert.equal(noAuth.status, 401);
});

test('m9d402 killswitch_reativacao_exige_mfa_step_up: ativar sem MFA passa pela porta; reativar sem step-up recebe MFA_STEP_UP_REQUIRED', { skip: !DISPOSABLE && SKIP_DISPOSABLE }, async () => {
  if (httpSkip) return;
  const ativar = await call('diretoria', 'POST', '/marketing/kill-switch', { scope: 'GLOBAL', active: true, reason: 'incidente simulado de teste' });
  assert.ok(!['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED', 'MKT_FORBIDDEN'].includes(ativar.body?.error?.code), 'ativação não exige MFA');
  const reativar = await call('diretoria', 'POST', '/marketing/kill-switch', { scope: 'GLOBAL', active: false, reason: 'incidente simulado resolvido' });
  assert.equal(reativar.status, 403);
  assert.equal(reativar.body.error.code, 'MFA_STEP_UP_REQUIRED');

  // Em serviço: com step-up recente a reativação passa; expirado volta a recusar.
  const { assertKillSwitchChangeAllowed } = require('../src/modules/marketing/marketing.guards');
  const inTx = (fn) => sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantA.userId }, transaction });
    const out = await fn(transaction);
    return out;
  });
  await inTx((transaction) => assertKillSwitchChangeAllowed({ active: true, userId: tenantA.userId, transaction }));
  await assert.rejects(
    () => inTx((transaction) => assertKillSwitchChangeAllowed({ active: false, userId: tenantA.userId, transaction })),
    (e) => e.statusCode === 403 && e.code === 'MFA_STEP_UP_REQUIRED'
  );
  const { MfaStepUp } = require('../src/models');
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    await MfaStepUp.create({
      userId: tenantA.userId, groupId: tenantA.groupId, companyId: tenantA.companyId,
      verifiedAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    }, { transaction });
    await assertKillSwitchChangeAllowed({ active: false, userId: tenantA.userId, transaction });
  } finally {
    await transaction.rollback().catch(() => {});
  }
});
