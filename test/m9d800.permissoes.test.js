'use strict';

// M9-D800 — Alicerce da governança (permissões, concessões, migration e RLS do schema governance).
// Rodar SEMPRE em banco descartável (nunca no .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d800.permissoes.test.js"
// Os testes que dependem do cluster descartável (DISPOSABLE_DB=1) ou do seed de dois tenants são PULADOS com motivo explícito
// fora dele; os estáticos rodam em qualquer lugar.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  setupEnv, teardownEnv, EXPECTED_PERMISSIONS, SENSITIVE_13, GESTAO_6, FINANCEIRO_5, DISPOSABLE, SKIP_DISPOSABLE, adminQuery,
} = require('./helpers/m9d800Env');

let sequelize;
let adminSequelize;

before(async () => {
  ({ sequelize, adminSequelize } = await setupEnv());
});

after(async () => {
  await teardownEnv();
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
