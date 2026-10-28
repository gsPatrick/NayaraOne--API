'use strict';

// M9-D800 — Alicerce da governança: pasta src/modules/core-governance (8 subpastas), schema `governance` com RLS FORCE,
// 21 permissões governance:*, catálogo de 7 eventos, corpo de erro único (error.traceId, prefixo GOV_), ordem de construção.
//
// Rodar SEMPRE em banco descartável (nunca no .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d800.alicerceGovernanca.test.js"
// Os testes que dependem do cluster descartável (DISPOSABLE_DB=1) ou do seed de dois tenants são PULADOS com motivo explícito
// fora dele; os estáticos (pastas, README, ordem, códigos de erro, catálogo) rodam em qualquer lugar.

process.env.PORT = process.env.M9D800_HTTP_TEST_PORT || '21650';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { Sequelize } = require('sequelize');

const API_ROOT = path.join(__dirname, '..');
const GOV_DIR = path.join(API_ROOT, 'src', 'modules', 'core-governance');
const DEMANDAS_DIR = path.join(API_ROOT, '..', 'Maturacao', 'demandas', 'marco-9');

const EXPECTED_MODULES = ['api-governance', 'bcp', 'calendar', 'data-quality', 'dlp', 'feature-flags', 'finops', 'lineage'];
const EXPECTED_PERMISSIONS = [
  'governance:calendar:read', 'governance:data-quality:read', 'governance:data-quality:manage', 'governance:data-quality:bulk',
  'governance:lineage:manage', 'governance:dlp:export', 'governance:dlp:admin', 'governance:dlp:view-restricted',
  'governance:bcp:record', 'governance:bcp:import', 'governance:bcp:approve', 'governance:api:read', 'governance:api:manage',
  'governance:finops:read', 'governance:finops:manage', 'governance:flags:manage', 'governance:migration:run',
  'governance:migration:admin', 'governance:classification:manage', 'governance:retention:manage', 'governance:legal-hold:manage',
];
const SENSITIVE_13 = [
  'governance:data-quality:bulk', 'governance:dlp:admin', 'governance:dlp:view-restricted', 'governance:bcp:approve',
  'governance:lineage:manage', 'governance:api:manage', 'governance:finops:manage', 'governance:flags:manage',
  'governance:migration:run', 'governance:migration:admin', 'governance:classification:manage', 'governance:retention:manage',
  'governance:legal-hold:manage',
];
const GESTAO_6 = ['governance:calendar:read', 'governance:data-quality:read', 'governance:data-quality:manage', 'governance:dlp:export', 'governance:api:read', 'governance:finops:read'];
const FINANCEIRO_5 = ['governance:calendar:read', 'governance:finops:read', 'governance:dlp:export', 'governance:bcp:record', 'governance:bcp:import'];
const EVENTS_7 = [
  'calendar.item.updated', 'data.quality.issue.opened', 'dlp.export.blocked', 'bcp.manual_operation.recorded',
  'bcp.manual_operation.imported', 'api.consumer.deprecation_due', 'finops.budget.threshold',
];
const README_TITLES = ['Objetivo', 'Tabelas', 'Rotas e permissões', 'Eventos', 'Jobs e horários', 'Parâmetros', 'Decisões (ADR)', 'Como testar', 'Como diagnosticar'];

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP_DISPOSABLE = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';

let adminSequelize;
let sequelize;
let baseUrl;
let appLoaded = false;
let httpSkip = null;
const tokens = {};

function adminClient() {
  return new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
}

async function adminQuery(sql, params) {
  const client = adminClient();
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

before(async () => {
  if (!DISPOSABLE) {
    httpSkip = SKIP_DISPOSABLE;
    return;
  }
  adminSequelize = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  ({ sequelize } = require('../src/models'));

  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../scripts/seed-ci-two-tenants');
  const seeded = password ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) {
    httpSkip = 'seed de dois tenants ausente (scripts/seed-ci-two-tenants.js com CI_TENANT_USERS_PASSWORD).';
    return;
  }

  // A permissão de leitura do calendário é dada ao perfil CI GESTOR da empresa A ANTES do login (o token carrega as
  // permissões efetivas lidas do banco). CI LEITURA fica sem nenhuma permissão de governança.
  await adminQuery(`
    INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now()
      FROM core.roles r CROSS JOIN core.permissions p
     WHERE r.name IN ('CI GESTOR') AND p.code IN ('governance:calendar:read', 'governance:finops:read')
       AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`);
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI LEITURA' AND p.code LIKE 'governance:%'`);

  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));

  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]) {
    let res; let body;
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailFor(tenant, profile), password }),
      });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (tentativa + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}: ${JSON.stringify(body)}`);
    tokens[`${tenant}:${profile}`] = body.data.accessToken;
  }
});

after(async () => {
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

test('m9d800 estrutura de pastas igual ao livro', () => {
  const entries = fs.readdirSync(GOV_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, EXPECTED_MODULES, 'core-governance deve ter exatamente as 8 subpastas do livro');
  for (const mod of EXPECTED_MODULES) {
    const files = fs.readdirSync(path.join(GOV_DIR, mod));
    for (const required of ['index.js', `${mod}.routes.js`, `${mod}.controller.js`, `${mod}.service.js`, 'README.md']) {
      assert.ok(files.includes(required), `${mod} sem ${required}`);
    }
    const mod_ = require(path.join(GOV_DIR, mod));
    assert.ok(mod_.router && typeof mod_.router === 'function', `${mod}/index.js deve exportar router`);
    assert.ok(mod_.service && typeof mod_.service === 'object', `${mod}/index.js deve exportar service`);
    assert.ok(Array.isArray(mod_.events), `${mod}/index.js deve exportar events`);
  }
});

test('m9d800 cada README tem os 9 títulos de seção', () => {
  for (const mod of EXPECTED_MODULES) {
    const text = fs.readFileSync(path.join(GOV_DIR, mod, 'README.md'), 'utf8');
    const headings = text.split('\n').filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+(\d+\.\s*)?/, '').trim());
    assert.deepEqual(headings.slice(0, 9), README_TITLES, `${mod}/README.md: 9 títulos fixos, na ordem`);
    for (const title of README_TITLES) {
      const body = text.split(new RegExp(`^##\\s+(?:\\d+\\.\\s*)?${title.replace(/[()]/g, '\\$&')}\\s*$`, 'm'))[1] || '';
      assert.ok(body.split(/^##\s/m)[0].trim().length > 10, `${mod}/README.md: seção "${title}" vazia`);
    }
  }
});

test('m9d800 catálogo de eventos tem exatamente os 7 tipos do livro', async () => {
  const events = require('../src/modules/core-governance/governance.events');
  assert.deepEqual([...events.GOVERNANCE_EVENT_TYPES].sort(), [...EVENTS_7].sort());
  const owned = EXPECTED_MODULES.flatMap((mod) => require(path.join(GOV_DIR, mod)).events);
  assert.deepEqual([...owned].sort(), [...EVENTS_7].sort(), 'cada evento pertence a exatamente um módulo');
  await assert.rejects(
    () => events.publishGovernanceEvent({ groupId: 'g', companyId: 'c', aggregateType: 'X', aggregateId: 'a', eventType: 'outro.evento', idempotencyKey: 'k' }, {}),
    (err) => err.code === 'GOV_EVENT_UNKNOWN' && err.statusCode === 500
  );
  await assert.rejects(
    () => events.publishGovernanceEvent({ groupId: 'g', companyId: 'c', aggregateType: 'X', aggregateId: 'a', eventType: 'calendar.item.updated' }, {}),
    (err) => err.code === 'GOV_EVENT_IDEMPOTENCY_REQUIRED'
  );
  // Nenhum arquivo do bloco publica evento fora do catálogo: todo eventType literal está entre os 7.
  for (const file of listJsFiles(GOV_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/eventType:\s*'([^']+)'/g)) assert.ok(EVENTS_7.includes(m[1]), `${path.relative(API_ROOT, file)}: evento fora do livro ${m[1]}`);
  }
});

test('m9d800 corpo de erro de governança tem formato único com error.traceId e código com prefixo GOV_ (exceto a lista fechada)', async () => {
  const errors = require('../src/modules/core-governance/governance.errors');
  assert.deepEqual(errors.DEFAULT_PREFIX_EXCEPTIONS, ['PERMISSION_DENIED', 'MISSING_ACCESS_TOKEN', 'MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED', 'INTERNAL_ERROR', 'VALIDATION_ERROR']);
  const nf = errors.govNotFound();
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.code, 'GOV_NOT_FOUND');
  assert.equal(nf.message, 'Registro não encontrado.');
  assert.throws(() => errors.govError(400, 'CODIGO_SEM_PREFIXO', 'x'), /prefixo GOV_/);
  assert.equal(errors.govError(403, 'PERMISSION_DENIED', 'x').code, 'PERMISSION_DENIED');

  // Varredura estática SOMENTE em core-governance: todo código em MAIÚSCULAS com sublinhado é GOV_ ou da lista fechada.
  const allowed = new Set(errors.DEFAULT_PREFIX_EXCEPTIONS);
  const offenders = [];
  for (const file of listJsFiles(GOV_DIR)) {
    if (file.endsWith('governance.errors.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g)) {
      if (!m[1].startsWith('GOV_') && !allowed.has(m[1])) offenders.push(`${path.relative(API_ROOT, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'códigos sem prefixo GOV_ fora da lista fechada');
});

test('m9d800 a tabela de ordem 3.5 coincide com o campo Dependências das demandas do bloco', () => {
  // Dependências esperadas, transcritas da tabela 3.5 (cada passo: ordem interna; a primeira depende das últimas do passo anterior).
  const esperado = {
    D801: ['D800'], D803: ['D801'], D802: ['D801', 'D803'],
    D804: ['D802'], D807: ['D804'], D805: ['D804', 'D807'], D806: ['D805'], D808: ['D806', 'D807'],
    D810: ['D806', 'D808'], D811: ['D810'],
    D820: ['D811'], D821: ['D820'], D822: ['D821'], D823: ['D821'], D824: ['D821'], D825: ['D821'],
    D830: ['D822', 'D823', 'D824', 'D825'], D831: ['D830'], D834: ['D831'], D832: ['D831', 'D834'], D833: ['D832'],
    D840: ['D833'], D841: ['D840'], D843: ['D840'], D842: ['D840', 'D843'], D844: ['D841', 'D843'],
    D850: ['D842', 'D843', 'D844'], D851: ['D850'], D852: ['D850', 'D843'],
    D860: ['D851', 'D852'], D861: ['D860'], D862: ['D860'], D863: ['D861', 'D862'],
    D870: ['D863'], D871: ['D870'], D872: ['D870'],
    D890: ['D802', 'D803', 'D808', 'D811', 'D822', 'D824', 'D825', 'D832', 'D834', 'D840', 'D842', 'D850', 'D851', 'D861', 'D863', 'D871', 'D872'],
    D891: ['D890'], D809: ['D891'],
  };
  const files = fs.readdirSync(DEMANDAS_DIR).filter((f) => /^M9-D\d{3}-.*\.md$/.test(f));
  const deps = {};
  for (const f of files) {
    const id = f.slice(3, 7);
    const line = fs.readFileSync(path.join(DEMANDAS_DIR, f), 'utf8').split('\n').find((l) => l.startsWith('| Dependências'));
    deps[id] = line ? [...line.matchAll(/M9-(D\d{3})/g)].map((m) => m[1]).sort() : null;
  }
  for (const [id, want] of Object.entries(esperado)) {
    assert.ok(deps[id], `demanda ${id} sem campo Dependências`);
    assert.deepEqual(deps[id], [...want].sort(), `Dependências de ${id} divergem da tabela 3.5`);
  }
  // Bloco F: a primeira demanda de cada trilha chega a D891 (F1, F2) ou não depende de ninguém (F4); D940 fecha as trilhas.
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps[from] || []).some((d) => reaches(d, target, seen));
  };
  assert.ok(reaches('D906', 'D891'), 'F1 começa depois de D891');
  assert.ok(reaches('D911', 'D891'), 'F2 começa depois de D891');
  assert.ok(reaches('D914', 'D901') && reaches('D914', 'D810'), 'F3 (D914) depende da migração e do lineage');
  assert.deepEqual(deps.D930, [], 'F4 não depende de ninguém');
  for (const id of ['D908', 'D910', 'D915', 'D920', 'D932']) assert.ok(deps.D940.includes(id), `D940 deve depender de ${id}`);
});

test('m9d800 permissões governance:* semeadas e na matriz', async () => {
  const perms = require('../src/modules/core-governance/governance.permissions');
  assert.deepEqual(perms.GOVERNANCE_PERMISSIONS.map((p) => p.code).sort(), [...EXPECTED_PERMISSIONS].sort());
  assert.equal(new Set(perms.GOVERNANCE_PERMISSIONS.map((p) => p.code)).size, 21);

  // Matriz gerada do código real: toda permissão governance:* exigida por rota está no catálogo e o catálogo completo entra no relatório.
  process.env.PORT = process.env.PORT || '0';
  const { gerar, gerarCatalogoGovernanca } = require('../scripts/gerarMatrizPermissoes');
  const rotas = gerar();
  const usadas = new Set(rotas.flatMap((r) => r.permissions).filter((p) => p.startsWith('governance:')));
  assert.ok(usadas.size >= 8, `esperava ao menos as 8 rotas do esqueleto, achei ${usadas.size}`);
  for (const p of usadas) assert.ok(EXPECTED_PERMISSIONS.includes(p), `permissão fora do catálogo: ${p}`);
  const catalogo = gerarCatalogoGovernanca(rotas);
  assert.deepEqual(catalogo.map((c) => c.code).sort(), [...EXPECTED_PERMISSIONS].sort(), 'matriz lista as 21 permissões');

  if (!DISPOSABLE) return; // a parte de banco só roda no cluster descartável
  const { rows } = await adminQuery("SELECT code, risk_level FROM core.permissions WHERE code LIKE 'governance:%' ORDER BY code");
  assert.deepEqual(rows.map((r) => r.code).sort(), [...EXPECTED_PERMISSIONS].sort());
  const admin = await adminQuery(`SELECT r.id, count(DISTINCT p.code)::int AS n FROM core.roles r
      JOIN core.role_permissions rp ON rp.role_id = r.id JOIN core.permissions p ON p.id = rp.permission_id
     WHERE r.name = 'ADMIN' AND p.code LIKE 'governance:%' GROUP BY r.id`);
  assert.ok(admin.rowCount >= 1);
  for (const row of admin.rows) assert.equal(row.n, 21, 'todo ADMIN recebe as 21');
});

test('m9d800 concessão padrão: perfil operacional recebe só calendar:read e só o administrador recebe as 13 sensíveis', async () => {
  const perms = require('../src/modules/core-governance/governance.permissions');
  assert.deepEqual([...perms.DEFAULT_GRANTS.GESTAO].sort(), [...GESTAO_6].sort());
  assert.deepEqual([...perms.DEFAULT_GRANTS.FINANCEIRO].sort(), [...FINANCEIRO_5].sort());
  assert.deepEqual(perms.DEFAULT_GRANTS.OPERACIONAL, ['governance:calendar:read']);
  assert.equal(perms.DEFAULT_GRANTS.ADMIN.length, 21);
  assert.deepEqual([...perms.SENSITIVE_PERMISSIONS].sort(), [...SENSITIVE_13].sort());
  for (const tier of ['GESTAO', 'FINANCEIRO', 'OPERACIONAL']) {
    for (const code of perms.DEFAULT_GRANTS[tier]) assert.ok(!SENSITIVE_13.includes(code), `${tier} não pode receber ${code}`);
  }
  assert.equal(perms.tierForRoleName('ADMIN', { gestao: [], financeiro: [] }), 'ADMIN');
  assert.equal(perms.tierForRoleName('Diretor', { gestao: ['DIRETOR'], financeiro: [] }), 'GESTAO');
  assert.equal(perms.tierForRoleName('financeiro', { gestao: [], financeiro: ['FINANCEIRO'] }), 'FINANCEIRO');
  assert.equal(perms.tierForRoleName('Corretor', { gestao: ['DIRETOR'], financeiro: ['FINANCEIRO'] }), 'OPERACIONAL');

  if (!DISPOSABLE) return;
  // Perfis criados DEPOIS da migration, na empresa A do seed: o serviço aplica a tabela, respeitando as listas configuráveis.
  const { rows: [company] } = await adminQuery("SELECT c.id, c.group_id FROM core.companies c WHERE c.name = 'Nayara One — Empresa Dev'");
  const tag = Date.now();
  const roles = {};
  for (const [key, name] of [['gerente', `M9D800 GERENTE ${tag}`], ['fin', `M9D800 FINANCEIRO ${tag}`], ['op', `M9D800 CORRETOR ${tag}`], ['custom', `M9D800 PERSONALIZADO ${tag}`]]) {
    const { rows: [r] } = await adminQuery(
      "INSERT INTO core.roles (id, group_id, company_id, name, is_system, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, false, now(), now()) RETURNING id",
      [company.group_id, company.id, name]
    );
    roles[key] = r.id;
  }
  const tenant = { groupId: company.group_id, companyId: company.id };
  const { upsertSetting } = require('../src/features/settings/settings.service');
  const { aplicarConcessaoPadrao } = perms;
  const { rows: [user] } = await adminQuery("SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'");
  const withTenant = async (fn) => sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: tenant.groupId, c: tenant.companyId, u: user.id }, transaction: t });
    return fn(t);
  });
  await withTenant((t) => upsertSetting('governanca.permissoes.perfis_gestao', `${'M9D800 GERENTE ' + tag}`, tenant, user.id, t));
  await withTenant((t) => upsertSetting('governanca.permissoes.perfis_financeiro', `${'M9D800 FINANCEIRO ' + tag}`, tenant, user.id, t));
  const summary = await withTenant((t) => aplicarConcessaoPadrao(tenant, user.id, t));
  assert.ok(summary.papeis >= 4);
  const grantsOf = async (id) => (await adminQuery("SELECT p.code FROM core.role_permissions rp JOIN core.permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 AND p.code LIKE 'governance:%' ORDER BY 1", [id])).rows.map((r) => r.code);
  assert.deepEqual(await grantsOf(roles.gerente), [...GESTAO_6].sort());
  assert.deepEqual(await grantsOf(roles.fin), [...FINANCEIRO_5].sort());
  assert.deepEqual(await grantsOf(roles.op), ['governance:calendar:read']);
  assert.deepEqual(await grantsOf(roles.custom), ['governance:calendar:read']);
  // Reexecutar não duplica nem concede mais nada.
  const again = await withTenant((t) => aplicarConcessaoPadrao(tenant, user.id, t));
  assert.equal(again.concedidas, 0);
  // Nenhum perfil não-ADMIN do banco recebeu permissão sensível.
  const leak = await adminQuery(`SELECT r.name, p.code FROM core.roles r JOIN core.role_permissions rp ON rp.role_id = r.id
      JOIN core.permissions p ON p.id = rp.permission_id
     WHERE r.name <> 'ADMIN' AND r.name LIKE 'M9D800%' AND p.code = ANY($1)`, [SENSITIVE_13]);
  assert.equal(leak.rowCount, 0);
});

test('m9d800 migration do schema governance idempotente e reversível', { skip: DISPOSABLE ? false : SKIP_DISPOSABLE }, async () => {
  const migration = require('../migrations/20260101000800-create-governance-schema-and-permissions');
  const qi = adminSequelize.getQueryInterface();
  const count = async (sql) => Number((await adminQuery(sql)).rows[0].n);
  const schemaExists = () => count("SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'governance'");
  const helperExists = () => count("SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'governance' AND p.proname = 'apply_tenant_rls'");
  const permCount = () => count("SELECT count(*) AS n FROM core.permissions WHERE code LIKE 'governance:%'");

  assert.equal(await schemaExists(), 1);
  await migration.up(qi); // segunda vez: sem erro
  assert.equal(await schemaExists(), 1);
  assert.equal(await helperExists(), 1);
  assert.equal(await permCount(), 21);

  await migration.down(qi);
  assert.equal(await permCount(), 0, 'down remove as permissões');
  assert.equal(await helperExists(), 0, 'down remove a função auxiliar');
  const tablesLeft = await count("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'governance'");
  assert.equal(await schemaExists(), tablesLeft === 0 ? 0 : 1, 'down só derruba o schema se estiver vazio');

  await migration.up(qi);
  assert.equal(await schemaExists(), 1);
  assert.equal(await permCount(), 21);
  assert.equal(await helperExists(), 1);
  const adminOk = await count(`SELECT count(*) AS n FROM (SELECT r.id FROM core.roles r JOIN core.role_permissions rp ON rp.role_id = r.id
      JOIN core.permissions p ON p.id = rp.permission_id WHERE r.name = 'ADMIN' AND p.code LIKE 'governance:%' GROUP BY r.id HAVING count(*) = 21) x`);
  assert.ok(adminOk >= 1, 'o up regrava as 21 no ADMIN');
  // GRANT guardado: o role de runtime enxerga o schema.
  const usage = await adminQuery("SELECT has_schema_privilege('nayara_runtime', 'governance', 'USAGE') AS ok");
  assert.equal(usage.rows[0].ok, true);
});

test('m9d800 RLS isola duas empresas', { skip: DISPOSABLE ? false : SKIP_DISPOSABLE }, async () => {
  const table = `governance.m9d800_probe_${Date.now()}`;
  await adminQuery(`CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL, company_id uuid NOT NULL,
      note text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  try {
    await adminQuery(`SELECT governance.apply_tenant_rls('${table}'::regclass)`);
    const flags = (await adminQuery("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass", [table])).rows[0];
    assert.equal(flags.relrowsecurity, true);
    assert.equal(flags.relforcerowsecurity, true);
    const { rows: companies } = await adminQuery('SELECT id, group_id FROM core.companies ORDER BY created_at LIMIT 2');
    assert.equal(companies.length, 2, 'precisa de duas empresas (seed dev + CI)');
    const [a, b] = companies;
    const inTenant = (c, fn) => sequelize.transaction(async (t) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: c.group_id, c: c.id }, transaction: t });
      return fn(t);
    });
    await inTenant(a, (t) => sequelize.query(`INSERT INTO ${table} (group_id, company_id, note) VALUES (:g, :c, 'da empresa A')`, { replacements: { g: a.group_id, c: a.id }, transaction: t }));
    const seenByA = await inTenant(a, (t) => sequelize.query(`SELECT note FROM ${table}`, { transaction: t }));
    assert.equal(seenByA[0].length, 1);
    const seenByB = await inTenant(b, (t) => sequelize.query(`SELECT note FROM ${table}`, { transaction: t }));
    assert.equal(seenByB[0].length, 0, 'empresa B não enxerga linha da A');
    // A empresa B também não consegue gravar linha com company_id da A (WITH CHECK).
    await assert.rejects(() => inTenant(b, (t) => sequelize.query(`INSERT INTO ${table} (group_id, company_id, note) VALUES (:g, :c, 'forjada')`, { replacements: { g: a.group_id, c: a.id }, transaction: t })), /row-level security/i);
    // Sem contexto de tenant: nada aparece.
    const naked = await sequelize.query(`SELECT note FROM ${table}`);
    assert.equal(naked[0].length, 0);
    // A função auxiliar recusa tabela fora do schema governance ou sem company_id.
    await assert.rejects(() => adminQuery("SELECT governance.apply_tenant_rls('core.permissions'::regclass)"), /governance/);
  } finally {
    await adminQuery(`DROP TABLE IF EXISTS ${table}`);
  }
});

test('m9d800 rota sem permissão devolve 403 (e 401 sem login, 200 com a permissão)', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const semToken = await call(null, 'GET', '/calendar');
  assert.equal(semToken.status, 401);
  assert.equal(semToken.body.success, false);
  assert.equal(semToken.body.error.code, 'MISSING_ACCESS_TOKEN');
  assert.equal(semToken.body.error.message, 'Token de acesso ausente.');
  assert.equal(semToken.body.error.traceId, semToken.correlation, 'traceId DENTRO de error, igual ao X-Correlation-Id');
  assert.equal(semToken.body.traceId, undefined, 'nunca traceId na raiz');

  const semPermissao = await call('A:leitura', 'GET', '/calendar');
  assert.equal(semPermissao.status, 403);
  assert.equal(semPermissao.body.error.code, 'PERMISSION_DENIED');
  assert.equal(semPermissao.body.error.details.required, 'governance:calendar:read');
  assert.equal(semPermissao.body.error.traceId, semPermissao.correlation);

  const comPermissao = await call('A:gestor', 'GET', '/calendar');
  assert.equal(comPermissao.status, 200, JSON.stringify(comPermissao.body));
  assert.equal(comPermissao.body.success, true);
  assert.equal(comPermissao.body.data.modulo, 'calendar');
  assert.equal(comPermissao.body.data.habilitado, true);

  // Rota de outro módulo exige a permissão dele: o gestor de CI não tem flags:manage.
  const flags = await call('A:gestor', 'GET', '/feature-flags');
  assert.equal(flags.status, 403);
  assert.equal(flags.body.error.details.required, 'governance:flags:manage');
  // O mesmo gestor tem finops:read (concedido no before) e vê o health do FinOps.
  const finops = await call('A:gestor', 'GET', '/finops/health');
  assert.equal(finops.status, 200);
  // As 8 rotas do esqueleto existem sob os prefixos do livro.
  for (const route of ['/data-quality', '/lineage', '/dlp', '/bcp', '/api-governance/consumers', '/feature-flags']) {
    const r = await call('A:leitura', 'GET', route);
    assert.equal(r.status, 403, `${route} deve exigir permissão`);
    assert.equal(r.body.error.traceId, r.correlation);
  }
});

test('m9d800 o administrador liga e desliga cada módulo (configuração por empresa)', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { upsertSetting } = require('../src/features/settings/settings.service');
  const { rows: [company] } = await adminQuery("SELECT c.id, c.group_id FROM core.companies c WHERE c.name LIKE 'CI%Empresa Fictícia A%'");
  const tenant = { groupId: company.group_id, companyId: company.id };
  const { rows: [user] } = await adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-gestor@ci.nayaraone.test'");
  const withTenant = (fn) => sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: tenant.groupId, c: tenant.companyId, u: user.id }, transaction: t });
    return fn(t);
  });
  await withTenant((t) => upsertSetting('governanca.modulos.calendar.habilitado', false, tenant, user.id, t));
  try {
    const off = await call('A:gestor', 'GET', '/calendar');
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, 'GOV_MODULE_DISABLED');
    assert.equal(off.body.error.traceId, off.correlation);
    // Só vale para a empresa que desligou: a empresa B (se tiver a permissão) não é afetada; sem permissão continua 403 por permissão.
    const semPermissaoPrimeiro = await call('A:leitura', 'GET', '/calendar');
    assert.equal(semPermissaoPrimeiro.body.error.code, 'PERMISSION_DENIED', 'a permissão é checada antes do módulo ligado');
  } finally {
    await withTenant((t) => upsertSetting('governanca.modulos.calendar.habilitado', true, tenant, user.id, t));
  }
  const on = await call('A:gestor', 'GET', '/calendar');
  assert.equal(on.status, 200);
  // Chave desconhecida continua recusada (fail closed) e as chaves novas têm faixa/tipo.
  await assert.rejects(() => withTenant((t) => upsertSetting('governanca.modulos.calendar.habilitado', 'sim', tenant, user.id, t)), /booleano/);
  await assert.rejects(() => withTenant((t) => upsertSetting('governanca.modulos.inexistente.habilitado', true, tenant, user.id, t)), /desconhecida/);
});

test('m9d800 a lista de exceções ao prefixo GOV_ configurada pelo administrador vale de fato', async (t) => {
  // Parte pura (sem banco): o enforcement troca código fora do padrão e respeita a lista recebida.
  const errors = require('../src/modules/core-governance/governance.errors');
  assert.equal(typeof errors.enforceErrorCode, 'function', 'a lista configurável precisa de consumidor (enforceErrorCode)');
  const only = errors.parseExceptions('MFA_STEP_UP_REQUIRED, ');
  assert.deepEqual(only, ['MFA_STEP_UP_REQUIRED']);
  const trocado = errors.enforceErrorCode({ code: 'PERMISSION_DENIED', message: 'x', details: { required: 'a' } }, only);
  assert.equal(trocado.code, 'GOV_CODIGO_FORA_DO_PADRAO');
  assert.equal(trocado.details.codigoOriginal, 'PERMISSION_DENIED');
  assert.equal(trocado.details.required, 'a');
  assert.equal(errors.enforceErrorCode({ code: 'PERMISSION_DENIED' }, errors.DEFAULT_PREFIX_EXCEPTIONS).code, 'PERMISSION_DENIED');
  assert.equal(errors.enforceErrorCode({ code: 'GOV_NOT_FOUND' }, only).code, 'GOV_NOT_FOUND');

  if (httpSkip) return t.skip(httpSkip);
  const { upsertSetting } = require('../src/features/settings/settings.service');
  const { rows: [company] } = await adminQuery("SELECT c.id, c.group_id FROM core.companies c WHERE c.name LIKE 'CI%Empresa Fictícia A%'");
  const tenant = { groupId: company.group_id, companyId: company.id };
  const { rows: [user] } = await adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-gestor@ci.nayaraone.test'");
  const withTenant = (fn) => sequelize.transaction(async (tx) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: tenant.groupId, c: tenant.companyId, u: user.id }, transaction: tx });
    return fn(tx);
  });
  const antes = await call('A:leitura', 'GET', '/calendar');
  assert.equal(antes.body.error.code, 'PERMISSION_DENIED', 'padrão do livro: PERMISSION_DENIED é exceção permitida');
  await withTenant((tx) => upsertSetting('governanca.erros.excecoes_prefixo_gov', 'MISSING_ACCESS_TOKEN', tenant, user.id, tx));
  try {
    const depois = await call('A:leitura', 'GET', '/calendar');
    assert.equal(depois.status, 403, 'o status HTTP não muda');
    assert.equal(depois.body.error.code, 'GOV_CODIGO_FORA_DO_PADRAO');
    assert.equal(depois.body.error.details.codigoOriginal, 'PERMISSION_DENIED');
    assert.equal(depois.body.error.traceId, depois.correlation);
    // A configuração é por empresa: a empresa B continua com o padrão.
    const outra = await call('B:gestor', 'GET', '/feature-flags');
    assert.equal(outra.body.error.code, 'PERMISSION_DENIED');
  } finally {
    await withTenant((tx) => upsertSetting('governanca.erros.excecoes_prefixo_gov', 'PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR', tenant, user.id, tx));
  }
  const restaurado = await call('A:leitura', 'GET', '/calendar');
  assert.equal(restaurado.body.error.code, 'PERMISSION_DENIED');
});

test('m9d800 configurações de governança registradas no dicionário com os padrões do catálogo', () => {
  const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
  const gov = require('../src/modules/core-governance/governance.settings');
  assert.equal(SETTINGS_SCHEMA['governanca.erros.excecoes_prefixo_gov'].type, 'string');
  assert.equal(gov.GOVERNANCE_SETTING_DEFAULTS['governanca.erros.excecoes_prefixo_gov'], 'PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR');
  for (const mod of EXPECTED_MODULES) {
    const key = `governanca.modulos.${mod.replace(/-/g, '_')}.habilitado`;
    assert.equal(SETTINGS_SCHEMA[key].type, 'boolean', key);
    assert.equal(gov.GOVERNANCE_SETTING_DEFAULTS[key], true, key);
  }
  for (const key of ['governanca.permissoes.perfis_gestao', 'governanca.permissoes.perfis_financeiro']) assert.equal(SETTINGS_SCHEMA[key].type, 'string', key);
  // Todo parâmetro do dicionário de governança consta no catálogo de parâmetros (parametros.csv).
  const csv = fs.readFileSync(path.join(API_ROOT, '..', 'Maturacao', 'demandas', 'parametros.csv'), 'utf8');
  for (const key of Object.keys(gov.GOVERNANCE_SETTING_DEFAULTS)) assert.ok(csv.includes(`"${key}"`), `${key} ausente de parametros.csv`);
});
