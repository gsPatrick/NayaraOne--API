'use strict';

// M9-D915 — fieldAccess: máscara por contexto, campo sem registro, falha fechada, auditoria da leitura em claro, isolamento entre empresas e TOKENIZE.
// Banco descartável: node scripts/withDisposableDb.js --port <55000-56999> -- env LOG_LEVEL=info CI_TENANT_USERS_PASSWORD=... CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310 bash -c
//   "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d915.campo.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d915Env');
const repository = require('../../../src/features/core-governance/data-quality/classification.repository');

let tenants;
const A = () => tenants.A;
const B = () => tenants.B;
const skip = () => env.skip();
const SEM = (tenant) => env.actorOf(tenant, []);
const COM = (tenant) => env.actorOf(tenant, [env.VIEW_RESTRICTED]);
const resolve = (tenant, actor, context, opts = {}, field = 'tax_id_normalized') => env.fieldAccess.resolveField('people.persons', field, actor, context, { value: env.CPF, ...opts });

before(async () => {
  if (!env.DISPOSABLE) return;
  tenants = await env.loadTenants();
  for (const tenant of [A(), B()]) await env.ensure(tenant);
  env.wiring.install(); // o resolvedor de classe do guard lê o registro (como na aplicação)
  process.env.DLP_TOKEN_KEY = process.env.DLP_TOKEN_KEY || 'chave-de-teste-m9d915';
});
after(async () => { await env.sequelize.close(); });

test('m9d915 field masking em tela, API e exportação', { skip: skip() }, async () => {
  for (const context of ['SCREEN', 'API']) {
    const masked = await resolve(A(), SEM(A()), context);
    assert.deepEqual([masked.visible, masked.maskedValue, masked.rule.outcome, masked.rule.classification], [true, '***.***.***-34', 'MASKED', 'RESTRICTED'], context);
  }
  const copy = await resolve(A(), SEM(A()), 'COPY');
  assert.equal(copy.maskedValue, '***.***.***-34', 'COPY segue a regra de tela');
  const clear = await resolve(A(), COM(A()), 'SCREEN');
  assert.deepEqual([clear.visible, clear.maskedValue, clear.rule.outcome], [true, env.CPF, 'CLEAR'], 'com governance:dlp:view-restricted o valor sai em claro');
  const formatted = await resolve(A(), SEM(A()), 'SCREEN', { value: env.CPF_FORMATTED });
  assert.equal(formatted.maskedValue, '***.***.***-34', 'CPF 123.456.789-34 vira ***.***.***-34');
  // Exportação: ALLOWED_MASKED sai mascarado (e-mail), FORBIDDEN some, ALLOWED sai em claro.
  await env.withColumn(A(), 'preferred_name', { classification: 'HIGH', masking: 'PARTIAL', exportability: 'ALLOWED_MASKED' }, async () => {
    const email = await resolve(A(), COM(A()), 'EXPORT', { value: 'joao@x.com' }, 'preferred_name');
    assert.deepEqual([email.visible, email.maskedValue], [true, 'j***@x.com']);
  });
  const forbidden = await resolve(A(), COM(A()), 'EXPORT');
  assert.deepEqual([forbidden.visible, forbidden.maskedValue, forbidden.rule.reason], [false, undefined, 'EXPORT_FORBIDDEN'], 'RESTRICTED vem FORBIDDEN do registro');
  await env.withColumn(A(), 'preferred_name', { classification: 'MEDIUM', masking: 'NONE', exportability: 'ALLOWED' }, async () => {
    assert.equal((await resolve(A(), SEM(A()), 'EXPORT', { value: 'Ana' }, 'preferred_name')).maskedValue, 'Ana');
  });
});

test('m9d915 os formatos de máscara do livro: CNPJ, telefone, conta, HASH e FULL', { skip: skip() }, async () => {
  const m = env.fieldMask.applyMasking;
  const ctx = (field, maskPattern = null) => ({ field, maskPattern, companyId: A().companyId, maskText: '••••••' });
  assert.equal(m('12.345.678/0001-90', 'PARTIAL', ctx('cnpj', '**.***.***/****-NN')), '**.***.***/****-90');
  assert.equal(m('(11) 98765-4321', 'PARTIAL', ctx('phone')), '(**) *****-4321');
  assert.equal(m('12345678-9', 'PARTIAL', ctx('account_number')), '****6789');
  assert.equal(m('maria@dominio.com', 'PARTIAL', ctx('email')), 'm***@dominio.com');
  assert.equal(m('segredo', 'FULL', ctx('x')), '••••••');
  const hash = m('abc', 'HASH', ctx('x'));
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.equal(m('abc', 'HASH', ctx('y')), hash, 'HASH permite comparar sem ver');
  assert.equal(m(null, 'PARTIAL', ctx('x')), null);
  assert.equal(m({ a: 1 }, 'PARTIAL', ctx('x')), '••••••', 'objeto só tem máscara total');
});

test('m9d915 campo sem registro usa a máscara da classe padrão de M9-D910', { skip: skip() }, async () => {
  const result = await env.fieldAccess.resolveField('people.persons', 'mother_name', SEM(A()), 'EXPORT', { value: 'Maria da Silva Santos' });
  assert.equal(result.rule.isDefault, true);
  assert.deepEqual([result.rule.classification, result.rule.masking, result.rule.finding.code], ['HIGH', 'PARTIAL', 'GOV_CLASSIFICATION_MISSING']);
  assert.equal(result.maskedValue, '****ntos', 'padrão sem registro: ALLOWED_MASKED com máscara parcial (4 últimos)');
  assert.equal(result.visible, true);
  const findings = await env.auditRows(A(), 'governance.classification.coverage_finding');
  assert.ok(findings.some((row) => row.after_json.column === 'people.persons.mother_name'), 'gera finding de cobertura');
});

test('m9d915 falha do registro mascara tudo', { skip: skip() }, async () => {
  const original = repository.find;
  repository.find = async () => { throw new Error('registro indisponível'); };
  try {
    for (const context of ['SCREEN', 'API', 'PRINT', 'LOG']) {
      const out = await resolve(A(), COM(A()), context);
      assert.deepEqual([out.visible, out.maskedValue, out.rule.reason], [true, '••••••', 'FAIL_CLOSED'], `${context}: nada em claro, mesmo com a permissão`);
    }
    for (const context of ['EXPORT', 'AI']) {
      const out = await resolve(A(), COM(A()), context);
      assert.deepEqual([out.visible, out.maskedValue], [false, undefined], `${context}: o campo é omitido`);
    }
  } finally { repository.find = original; }
  assert.ok((await env.auditRows(A(), 'governance.field_access.fail_closed')).length >= 1, 'a falha é auditada');
});

test('m9d915 leitura em claro audita (sem o valor) e leitura mascarada não', { skip: skip() }, async () => {
  const before = (await env.auditRows(A(), 'governance.field_access.clear_read')).length;
  await resolve(A(), SEM(A()), 'SCREEN');
  assert.equal((await env.auditRows(A(), 'governance.field_access.clear_read')).length, before, 'mascarado não audita leitura em claro');
  const out = await resolve(A(), COM(A()), 'API');
  assert.equal(out.maskedValue, env.CPF);
  const rows = await env.auditRows(A(), 'governance.field_access.clear_read');
  assert.equal(rows.length, before + 1);
  assert.deepEqual([rows[0].after_json.context, rows[0].after_json.fields, rows[0].user_id], ['API', ['people.persons.tax_id_normalized'], A().userId]);
  assert.ok(!JSON.stringify(rows[0]).includes(env.CPF), 'a auditoria nunca guarda o valor');
});

test('m9d915 o valor em claro de RESTRICTED exige a permissão do módulo de origem junto com a dedicada', { skip: skip() }, async () => {
  const semModulo = await resolve(A(), COM(A()), 'SCREEN', { originPermission: 'people:read' });
  assert.equal(semModulo.maskedValue, '***.***.***-34');
  const comModulo = await resolve(A(), env.actorOf(A(), [env.VIEW_RESTRICTED, 'people:read']), 'SCREEN', { originPermission: 'people:read' });
  assert.equal(comModulo.maskedValue, env.CPF);
  const impressao = await resolve(A(), COM(A()), 'PRINT');
  assert.equal(impressao.visible, false, 'PRINT segue a exportabilidade do registro (FORBIDDEN)');
});

test('m9d915 contexto inválido e ator sem empresa são recusados', { skip: skip() }, async () => {
  assert.equal((await env.refused(resolve(A(), SEM(A()), 'FAX'))).code, 'GOV_FIELD_CONTEXT_INVALID');
  assert.equal((await env.refused(env.fieldAccess.resolveField('people.persons', 'x', { userId: 'u' }, 'SCREEN'))).code, 'GOV_FIELD_ACTOR_INVALID');
  assert.equal((await env.refused(env.fieldAccess.resolveField('semponto', 'x', SEM(A()), 'SCREEN'))).code, 'GOV_FIELD_ENTITY_INVALID');
});

test('m9d915 isolamento entre empresas: o registro e a auditoria de cada empresa só valem para ela', { skip: skip() }, async () => {
  await env.withColumn(A(), 'preferred_name', { classification: 'RESTRICTED', masking: 'FULL', exportability: 'FORBIDDEN' }, async () => {
    const a = await resolve(A(), SEM(A()), 'SCREEN', { value: 'Ana Souza' }, 'preferred_name');
    const b = await resolve(B(), SEM(B()), 'SCREEN', { value: 'Ana Souza' }, 'preferred_name');
    assert.deepEqual([a.rule.classification, a.maskedValue], ['RESTRICTED', '••••••']);
    assert.notEqual(b.rule.classification, 'RESTRICTED', 'a empresa B não herda o ajuste da A');
    assert.equal(b.maskedValue, 'Ana Souza');
  });
  const rows = await env.adminQuery("SELECT company_id, user_id FROM audit.audit_log WHERE action = 'governance.field_access.clear_read' AND after_json::text LIKE '%preferred_name%'");
  assert.ok(rows.rows.length >= 1 && rows.rows.every((row) => row.company_id === B().companyId && row.user_id === B().userId), 'só a leitura em claro da empresa B foi auditada, e na empresa B');
});

test('m9d915 TOKENIZE é estável por empresa e diferente entre empresas', { skip: skip() }, async () => {
  const token = (tenant, value) => env.fieldMask.applyMasking(value, 'TOKENIZE', { field: 'x', companyId: tenant.companyId, maskText: '••••••' });
  const a1 = token(A(), env.CPF);
  assert.match(a1, /^tok_[0-9a-f]{16}$/);
  assert.equal(token(A(), env.CPF), a1, 'estável');
  assert.notEqual(token(B(), env.CPF), a1, 'diferente entre empresas');
  assert.notEqual(token(A(), '99999999999'), a1);
  const saved = process.env.DLP_TOKEN_KEY;
  delete process.env.DLP_TOKEN_KEY;
  try { assert.equal(token(A(), env.CPF), '••••••', 'sem a chave do ambiente cai na máscara total'); } finally { process.env.DLP_TOKEN_KEY = saved; }
  const viaRegistry = await env.withColumn(A(), 'preferred_name', { classification: 'HIGH', masking: 'TOKENIZE', exportability: 'ALLOWED_MASKED' }, () => resolve(A(), SEM(A()), 'EXPORT', { value: 'Ana' }, 'preferred_name'));
  assert.match(viaRegistry.maskedValue, /^tok_/);
});
