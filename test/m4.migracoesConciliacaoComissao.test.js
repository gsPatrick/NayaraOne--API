'use strict';

// Ida e volta das migrations de dados desta correção, no banco descartável (superusuário de DATABASE_ADMIN_URL, como test/m4d140):
//  - 20260101010410 (DEC-005): regra de comissão gravada como REG-FIN-002 passa a REG-FIN-001 sem mudar ids, versões nem o vínculo das comissões;
//    REG-FIN-002 de outro formato (limite de aprovação) fica; empresa que já tem REG-FIN-001 faz a migração parar (sem mescla às cegas).
//  - 20260101010411 (Guia §10): duplicatas de fingerprint tratadas sem apagar (desambiguação auditada) antes do UNIQUE completo; volta restaura.
//  - 20260101010412 (§11 fonte confiável): linhas existentes ficam LEGACY/não confiáveis, contagem auditada; CHECK impede digitada confiável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Sequelize } = require('sequelize');
const { sequelize, withTenantTransaction, uniqueSuffix, createTestResultCenter } = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const commissionsService = require('../src/modules/finance/application/services/commission.service');
const financialEntries = require('../src/modules/finance/application/services/financial-entry.service');
const bankAccounts = require('../src/modules/finance/application/services/bank-accounts.service');

const DIR = '../src/modules/finance/infrastructure/db/migrations/';
const mig = (nome) => require(`${DIR}${nome}`); // por teste: na base sem a migration, só o teste dela falha

const ADMIN_URL = process.env.DATABASE_ADMIN_URL;
let admin;
let qi;
before(() => {
  assert.ok(ADMIN_URL && /@127\.0\.0\.1:/.test(ADMIN_URL), 'rode via scripts/withDisposableDb.js (DATABASE_ADMIN_URL do banco descartável)');
  admin = new Sequelize(ADMIN_URL, { dialect: 'postgres', logging: false });
  qi = admin.getQueryInterface();
});
after(async () => {
  await admin.close();
  await closeIsolated();
  await sequelize.close();
});

const one = async (sql, replacements) => (await admin.query(sql, { replacements, type: Sequelize.QueryTypes.SELECT }))[0];
const all = (sql, replacements) => admin.query(sql, { replacements, type: Sequelize.QueryTypes.SELECT });

test('migration 20260101010410 (DEC-005): ida move a comissão para REG-FIN-001 com auditoria e nada some; volta devolve; conflito para', async () => {
  const m0410 = mig('20260101010410-finance-comissao-regra-reg-fin-001');
  const iso = await isolatedTenant('dec005');
  const made = await withTenantTransaction(iso, async (t) => {
    await commissionsService.publishCommissionRuleVersion({ ...iso, componentPercentages: { BROKER: 4 } }, iso.userId, t);
    const v2 = await commissionsService.publishCommissionRuleVersion({ ...iso, componentPercentages: { BROKER: 5 } }, iso.userId, t);
    const rc = await createTestResultCenter(iso, t);
    const src = await financialEntries.createFinancialEntry({ ...iso, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, resultCenterId: rc.id, description: 'DEC-005' }, iso.userId, t);
    const { commission } = await commissionsService.createCommission({ ...iso, beneficiaryUserId: iso.userId, sourceEntryId: src.id, component: 'BROKER', idempotencyKey: `dec005-${uniqueSuffix()}` }, iso.userId, t);
    return { versionId: v2.id, commissionId: commission.id };
  });
  const { rule_id: ruleId } = await one('SELECT rule_id FROM core.rule_versions WHERE id = :id', { id: made.versionId });
  // Estado legado (antes da DEC-005): a regra de comissão gravada como REG-FIN-002; e uma REG-FIN-002 de limite de aprovação na mesma empresa.
  await admin.query("UPDATE core.rules SET code = 'REG-FIN-002' WHERE id = :id", { replacements: { id: ruleId } });
  const limitRuleId = randomUUID();
  await admin.query(`INSERT INTO core.rules (id, group_id, company_id, code, name, domain, created_at, updated_at) VALUES (:id, :g, :c, 'REG-FIN-002', 'Limite de aprovação', 'finance', now(), now())`, { replacements: { id: limitRuleId, g: iso.groupId, c: iso.companyId } });
  await admin.query(`INSERT INTO core.rule_versions (id, group_id, company_id, rule_id, version_number, condition_ast_json, content_hash, action_json, effective_from, status, created_at, updated_at)
                     VALUES (gen_random_uuid(), :g, :c, :r, 1, '{"fact":"x","op":"==","value":true}', 'h', '{"maxAmount":"10000.00","approvers":2}', now(), 'PUBLISHED', now(), now())`, { replacements: { g: iso.groupId, c: iso.companyId, r: limitRuleId } });
  const versionsBefore = await all('SELECT id, version_number FROM core.rule_versions WHERE rule_id = :id ORDER BY version_number', { id: ruleId });
  assert.equal(versionsBefore.length, 2);

  await m0410.up(qi, Sequelize);
  assert.equal((await one('SELECT code FROM core.rules WHERE id = :id', { id: ruleId })).code, 'REG-FIN-001');
  assert.equal((await one('SELECT code FROM core.rules WHERE id = :id', { id: limitRuleId })).code, 'REG-FIN-002', 'limite de aprovação não é tocado');
  assert.deepEqual(await all('SELECT id, version_number FROM core.rule_versions WHERE rule_id = :id ORDER BY version_number', { id: ruleId }), versionsBefore, 'mesmos ids e números de versão');
  assert.equal((await one('SELECT rule_version_id FROM finance.commissions WHERE id = :id', { id: made.commissionId })).rule_version_id, made.versionId);
  const audit = await all("SELECT before_json, after_json FROM audit.audit_log WHERE action = 'finance.commission_rule.code_migrated' AND entity_id = :id", { id: ruleId });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].before_json.code, 'REG-FIN-002');
  assert.equal(audit[0].after_json.code, 'REG-FIN-001');
  assert.equal(audit[0].before_json.commissions, 1);
  assert.deepEqual(audit[0].after_json.versions, audit[0].before_json.versions);

  await m0410.down(qi, Sequelize);
  assert.equal((await one('SELECT code FROM core.rules WHERE id = :id', { id: ruleId })).code, 'REG-FIN-002', 'a volta devolve o código antigo');
  assert.equal((await all("SELECT 1 FROM audit.audit_log WHERE action = 'finance.commission_rule.code_migration_reverted' AND entity_id = :id", { id: ruleId })).length, 1);

  const dummy = randomUUID();
  await admin.query(`INSERT INTO core.rules (id, group_id, company_id, code, name, domain, created_at, updated_at) VALUES (:id, :g, :c, 'REG-FIN-001', 'Outra regra', 'finance', now(), now())`, { replacements: { id: dummy, g: iso.groupId, c: iso.companyId } });
  await assert.rejects(m0410.up(qi, Sequelize), /DEC-005: empresa\(s\) .* já têm REG-FIN-001/);
  assert.equal((await one('SELECT code FROM core.rules WHERE id = :id', { id: ruleId })).code, 'REG-FIN-002', 'abortada, nada mudou');
  await admin.query('DELETE FROM core.rules WHERE id = :id', { replacements: { id: dummy } });
  await m0410.up(qi, Sequelize);
  assert.equal((await one('SELECT code FROM core.rules WHERE id = :id', { id: ruleId })).code, 'REG-FIN-001');
  await withTenantTransaction(iso, async (t) => {
    const active = await commissionsService.getActiveCommissionRule(iso.groupId, iso.companyId, t);
    assert.equal(active.ruleVersionId, made.versionId, 'o código novo acha a versão migrada');
  });
  await admin.query('DELETE FROM core.rule_versions WHERE rule_id = :id', { replacements: { id: limitRuleId } });
  await admin.query('DELETE FROM core.rules WHERE id = :id', { replacements: { id: limitRuleId } });
});

test('migration 20260101010411 (Guia §10): duplicatas tratadas antes do UNIQUE completo, com contagem e auditoria; ida e volta', async () => {
  const m0411 = mig('20260101010411-finance-extrato-fingerprint-unico');
  const iso = await isolatedTenant('fp-mig');
  const acc = await withTenantTransaction(iso, (t) => bankAccounts.createBankAccount({ ...iso, bankCode: '237', agency: '0001', accountNumber: `MIG-${uniqueSuffix()}` }, iso.userId, t));
  await m0411.down(qi, Sequelize); // estado anterior: índice parcial
  assert.match((await one("SELECT indexdef FROM pg_indexes WHERE indexname = 'bank_transactions_account_fingerprint_uk'")).indexdef, /WHERE \(external_transaction_id IS NOT NULL\)/);
  const ins = (desc, minutes) => admin.query(`INSERT INTO finance.bank_transactions (id, group_id, company_id, bank_account_id, amount, transaction_date, description, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :a, 99.90, '2026-11-02T15:00:00Z', :d, now() + (:m || ' minutes')::interval, now())`, { replacements: { g: iso.groupId, c: iso.companyId, a: acc.id, d: desc, m: String(minutes) } });
  await ins('PIX DUPLICADO', 0);
  await ins('PIX DUPLICADO', 1);
  await ins('PIX DUPLICADO', 2);
  await ins('PIX UNICO', 3);
  const rows = () => all('SELECT id, fingerprint, created_at FROM finance.bank_transactions WHERE bank_account_id = :a ORDER BY created_at', { a: acc.id });
  const before = await rows();
  assert.equal(new Set(before.slice(0, 3).map((r) => r.fingerprint)).size, 1, 'três linhas iguais');

  await m0411.up(qi, Sequelize);
  const afterUp = await rows();
  assert.equal(afterUp.length, 4, 'nada apagado');
  assert.equal(afterUp[0].fingerprint, before[0].fingerprint, 'a mais antiga mantém o fingerprint');
  assert.equal(new Set(afterUp.map((r) => r.fingerprint)).size, 4);
  const audit = await all("SELECT entity_id, before_json, after_json FROM audit.audit_log WHERE action = 'finance.bank_transaction.fingerprint_disambiguated' AND company_id = :c ORDER BY occurred_at", { c: iso.companyId });
  assert.deepEqual(audit.map((a) => a.entity_id).sort(), [before[1].id, before[2].id].sort());
  for (const a of audit) assert.equal(a.after_json.keptBankTransactionId, before[0].id);
  const resumo = await one("SELECT after_json FROM audit.audit_log WHERE action = 'finance.bank_transaction.fingerprint_unique_migration' AND company_id = :c", { c: iso.companyId });
  assert.equal(resumo.after_json.linhasDesambiguadasNaEmpresa, 2);
  assert.equal(resumo.after_json.paresRepetidosNaTabela, 0);
  assert.doesNotMatch((await one("SELECT indexdef FROM pg_indexes WHERE indexname = 'bank_transactions_account_fingerprint_uk'")).indexdef, /WHERE/);

  await m0411.down(qi, Sequelize);
  assert.deepEqual((await rows()).map((r) => r.fingerprint), before.map((r) => r.fingerprint), 'a volta devolve os fingerprints originais');
  await m0411.up(qi, Sequelize);
  assert.doesNotMatch((await one("SELECT indexdef FROM pg_indexes WHERE indexname = 'bank_transactions_account_fingerprint_uk'")).indexdef, /WHERE/);
});

test('migration 20260101010412 (§11 fonte confiável): linhas existentes viram LEGACY e não confiáveis, contagem auditada; CHECK barra digitada confiável', async () => {
  const m0412 = mig('20260101010412-finance-extrato-origem-confiavel');
  const iso = await isolatedTenant('origem');
  const acc = await withTenantTransaction(iso, (t) => bankAccounts.createBankAccount({ ...iso, bankCode: '104', agency: '0001', accountNumber: `ORI-${uniqueSuffix()}` }, iso.userId, t));
  await m0412.down(qi, Sequelize);
  assert.equal((await all("SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'bank_transactions' AND column_name IN ('source', 'source_trusted')")).length, 0);
  await admin.query(`INSERT INTO finance.bank_transactions (id, group_id, company_id, bank_account_id, amount, transaction_date, description, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :a, 12.34, '2026-11-02T15:00:00Z', 'ANTES DA ORIGEM', now(), now())`, { replacements: { g: iso.groupId, c: iso.companyId, a: acc.id } });
  await m0412.up(qi, Sequelize);
  const row = await one('SELECT source, source_trusted FROM finance.bank_transactions WHERE bank_account_id = :a', { a: acc.id });
  assert.deepEqual(row, { source: 'LEGACY', source_trusted: false });
  const audit = await one("SELECT before_json, after_json FROM audit.audit_log WHERE action = 'finance.bank_transaction.source_backfill' AND company_id = :c ORDER BY occurred_at DESC LIMIT 1", { c: iso.companyId });
  assert.equal(audit.before_json.linhas, 1);
  assert.equal(audit.after_json.linhas, 1);
  await assert.rejects(
    admin.query(`INSERT INTO finance.bank_transactions (id, group_id, company_id, bank_account_id, amount, transaction_date, description, source, source_trusted, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :a, 1.00, now(), 'forjada', 'MANUAL', true, now(), now())`, { replacements: { g: iso.groupId, c: iso.companyId, a: acc.id } }),
    /bank_transactions_source_trusted_ck/
  );
});
