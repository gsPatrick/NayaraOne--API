'use strict';

// M9-D910 — o registro de classificação: 7 atributos do livro, cobertura de 100% das colunas de negócio (CI), regras automáticas por palavra inteira e a política de retenção de cada coluna.
// Banco descartável: node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//   "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d910.registro.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d910Env');
const rules = require('../../../src/features/core-governance/data-quality/classification.rules');

let tenants;
const A = () => tenants.A;
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetRetention(A()); } });
after(async () => { if (env.DISPOSABLE) { await env.adminQuery('ALTER TABLE people.persons DROP COLUMN IF EXISTS qa_m9d910_mother_name'); await env.resetRetention(A()); } await env.sequelize.close(); });

test('m9d910 os 7 atributos do livro existem na tabela (classification, purpose, retention_policy, masking, exportability, AI_allowed, owner)', { skip: env.skip() }, async () => {
  const cols = (await env.adminQuery("SELECT column_name FROM information_schema.columns WHERE table_schema = 'governance' AND table_name = 'data_classification_registry'")).rows.map((r) => r.column_name);
  for (const c of ['classification', 'purpose', 'retention_policy_id', 'masking', 'mask_pattern', 'exportability', 'ai_allowed', 'owner_domain', 'schema_name', 'table_name', 'column_name']) assert.ok(cols.includes(c), c);
  const fk = await env.adminQuery("SELECT 1 FROM pg_constraint WHERE conrelid = 'governance.data_classification_registry'::regclass AND contype = 'f' AND confrelid = 'governance.retention_policies'::regclass");
  assert.equal(fk.rowCount, 1, 'retention_policy_id aponta para a política da D911');
  const nullable = (await env.adminQuery("SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'governance' AND table_name = 'data_classification_registry' AND column_name = 'retention_policy_id'")).rows[0].is_nullable;
  assert.equal(nullable, 'NO', 'a política de retenção é obrigatória');
});

test('m9d910 coluna sem classificação reprova o CI: persons.mother_name sem entrada => GOV_CLASSIFICATION_MISSING, exit 1; sem a coluna, exit 0 com 100%', { skip: env.skip() }, async () => {
  const clean = env.runCoverageScript();
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /cobertura de classificação 100%/);
  await env.adminQuery('ALTER TABLE people.persons ADD COLUMN qa_m9d910_mother_name text');
  try {
    const bad = env.runCoverageScript();
    assert.equal(bad.status, 1);
    assert.match(bad.out, /GOV_CLASSIFICATION_MISSING people\.persons\.qa_m9d910_mother_name/);
    const { rows } = await env.adminQuery(env.inventory.CATALOG_SQL);
    const diff = env.inventory.diff(env.inventory.read().columns, env.inventory.columnsFromCatalog(rows));
    assert.deepEqual(diff.missing, ['people.persons.qa_m9d910_mother_name']);
  } finally { await env.adminQuery('ALTER TABLE people.persons DROP COLUMN qa_m9d910_mother_name'); }
  assert.equal(env.runCoverageScript().status, 0);
});

test('m9d910 o seed classifica 100% das colunas do inventário na empresa, com os atributos válidos e a política de retenção', { skip: env.skip() }, async () => {
  await env.resetRegistry(A());
  const created = await env.ensure(A());
  const total = env.inventory.flatten(env.inventory.read().columns).length;
  assert.equal(created, total);
  const { rows } = await env.adminQuery('SELECT count(*)::int AS n, count(*) FILTER (WHERE retention_policy_id IS NULL)::int AS sem FROM governance.data_classification_registry WHERE company_id = $1', [A().companyId]);
  assert.deepEqual([rows[0].n, rows[0].sem], [total, 0]);
  assert.equal(await env.ensure(A()), 0, 'semear de novo não cria nem sobrescreve nada');
  const cov = await env.inTx(A(), (tx) => env.classification.coverageOf(A(), tx));
  assert.deepEqual([cov.total, cov.registered >= total, cov.missing], [total, true, []]);
});

test('m9d910 regras automáticas classificam cpf, pix e email: pix_key RESTRICTED, email HIGH, cpf RESTRICTED com máscara dos 2 últimos dígitos', { skip: env.skip() }, async () => {
  assert.equal(rules.classify('finance', 'bank_accounts', 'pix_key').classification, 'RESTRICTED');
  assert.equal(rules.classify('people', 'person_contacts', 'email').classification, 'HIGH');
  assert.equal(rules.classify('people', 'persons', 'cpf').classification, 'RESTRICTED');
  assert.deepEqual([rules.maskingOf('cpf', 'RESTRICTED').masking, rules.maskingOf('cpf', 'RESTRICTED').maskPattern], ['PARTIAL', '***.***.***-NN']);
  assert.equal(rules.classify('real_estate', 'property_offers', 'asking_price').classification, 'LOW', 'preço anunciado');
  assert.equal(rules.classify('legal', 'contracts', 'contract_number').classification, 'HIGH', 'dado contratual');
  assert.equal(rules.classify('inventory', 'assets', 'description').classification, 'MEDIUM');
  const persisted = await env.rowOf(A(), 'people', 'persons', 'tax_id_normalized');
  assert.deepEqual([persisted.classification, persisted.masking, persisted.exportability, persisted.ai_allowed], ['RESTRICTED', 'PARTIAL', 'FORBIDDEN', false]);
  const email = await env.rowOf(A(), 'people', 'person_contacts', 'value_normalized');
  assert.ok(email, 'a coluna de contato está no registro');
});

test('m9d910 a regra automática casa palavra inteira: rg_number é RESTRICTED e merge_flag, target e org não', () => {
  assert.equal(rules.classify('people', 'persons', 'rg_number').classification, 'RESTRICTED');
  for (const column of ['merge_flag', 'target_id', 'org_unit', 'merged_into_id']) assert.notEqual(rules.classify('people', 'persons', column).classification, 'RESTRICTED', column);
  assert.equal(rules.classify('people', 'persons', 'mother_name').classification, 'HIGH', 'name de pessoa');
  assert.notEqual(rules.classify('inventory', 'assets', 'name').classification, 'HIGH', 'name de item não é de pessoa');
  assert.equal(rules.classify('x', 'y', 'company_account_ref').classification, 'RESTRICTED', 'account é palavra inteira');
});

test('m9d910 coluna fora dos tipos de dado do D911 recebe REVIEW_DEFAULT e as dos tipos conhecidos recebem a política do seu tipo', { skip: env.skip() }, async () => {
  const policies = await env.policies(A());
  const idOf = (code) => policies.find((p) => p.code === code).id;
  const check = async (schema, table, column, code) => assert.equal((await env.rowOf(A(), schema, table, column)).retention_policy_id, idOf(code), `${schema}.${table}.${column} => ${code}`);
  await check('crm', 'opportunities', 'stage', 'REVIEW_DEFAULT');
  await check('inventory', 'assets', 'asset_tag', 'REVIEW_DEFAULT');
  await check('governance', 'access_signals', 'action', 'LOGS_TECNICOS');
  await check('audit', 'audit_log', 'action', 'AUDITORIA_SEGURANCA');
  await check('legal', 'contracts', 'status', 'CONTRATOS');
  await check('legal', 'legal_cases', 'summary', 'JURIDICO');
  await check('finance', 'tax_documents', 'document_number', 'FISCAL');
  await check('correspondent', 'fiscal_obligations', 'status', 'FISCAL');
  await check('people', 'persons', 'legal_name', 'LEADS');
  await check('people', 'person_contacts', 'value_normalized', 'LEADS');
  await check('integration', 'webhook_inbox', 'payload_hash', 'INTEGRACAO');
  const outbox = await env.rowOf(A(), 'integration', 'outbox_events', 'classification');
  assert.equal(outbox.owner_domain, 'CLASSIFICACAO_TECNICA', 'classificação de falha é técnica e fica fora do mapeamento de sensibilidade');
});
