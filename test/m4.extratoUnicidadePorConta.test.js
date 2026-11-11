'use strict';

// Guia M4 §10 "Importação bancária idempotente: fingerprint ... UNIQUE(bank_account_id, fingerprint)"
// e isolamento entre empresas (FIN-001/FIN-TS-020). Defeito achado na captura ao vivo do
// fechamento do Marco 4 (10/11/2026): external_transaction_id era UNIQUE GLOBAL — a empresa B,
// importando a PRÓPRIA conta com um id externo igual ao de uma linha da empresa A, recebia 409
// UNIQUE_CONSTRAINT_VIOLATION (vazava a existência do dado de A e bloqueava a importação). O
// mesmo valia para financial_entries.idempotency_key. Migration 20260101009985: unicidade por
// conta (extrato) e por empresa (lançamento). HTTP real contra o app, duas empresas isoladas (grupos próprios).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_EXTRATO_TEST_PORT || '21616';
require('../app');
const T = require('./testHelpers');
const { tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const { bankTransactionFingerprint } = require('../src/modules/finance/infrastructure/db/bank-transaction-fingerprint');
const { BankTransaction } = require('../src/models');

const ctx = {};
let http;

const account = (tenant) => T.withTenantTransaction(tenant, (t) => bankAccountsService.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t));

before(async () => {
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  await new Promise((r) => setTimeout(r, 300));
  for (const key of ['A', 'B']) {
    const tenant = await isolatedTenant(`extrato-${key}`);
    ctx[key] = { tenant, token: tokenFor(tenant, tenant.userId), account: await account(tenant) };
  }
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

const csv = (extId, amount = '12.34') => `externalTransactionId,transactionDate,description,amount\n${extId},2026-11-10,a,${amount}`;
const importCsv = (who, bankAccountId, text) => http('POST', '/finance/bank-transactions/import', ctx[who].token, { bankAccountId, csvText: text });

test('M4-G§10 a empresa B importa a PRÓPRIA conta com o mesmo id externo de uma linha da empresa A: 201 com 1 linha nova (antes 409 UNIQUE_CONSTRAINT_VIOLATION); B não enxerga a linha de A', async () => {
  const ext = `EXT-X-${T.uniqueSuffix()}`;
  const a = await importCsv('A', ctx.A.account.id, csv(ext));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.data.imported.length, 1);
  const b = await importCsv('B', ctx.B.account.id, csv(ext));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.data.imported.length, 1);
  assert.equal(b.body.data.duplicates.length, 0);
  const seenByB = (await http('GET', '/finance/bank-transactions', ctx.B.token)).body.data.filter((x) => x.externalTransactionId === ext);
  assert.equal(seenByB.length, 1, 'B só vê a própria linha');
  assert.equal(seenByB[0].bankAccountId, ctx.B.account.id);
});

test('M4-G§10 reimportar na MESMA conta continua deduplicando (201, 1 duplicada, 0 novas) e a linha avulsa com a mesma chave na mesma conta é 409 FINANCE_BANK_TRANSACTION_DUPLICATE; outra conta da mesma empresa aceita', async () => {
  const ext = `EXT-Y-${T.uniqueSuffix()}`;
  assert.equal((await importCsv('A', ctx.A.account.id, csv(ext))).body.data.imported.length, 1);
  const again = await importCsv('A', ctx.A.account.id, csv(ext));
  assert.equal(again.status, 201);
  assert.equal(again.body.data.imported.length, 0);
  assert.equal(again.body.data.duplicates.length, 1);
  const single = await http('POST', '/finance/bank-transactions', ctx.A.token, { bankAccountId: ctx.A.account.id, externalTransactionId: ext, amount: 12.34, transactionDate: '2026-11-10' });
  assert.equal(single.status, 409, JSON.stringify(single.body));
  assert.equal(single.code, 'FINANCE_BANK_TRANSACTION_DUPLICATE');
  const otherAccount = await account(ctx.A.tenant);
  const other = await importCsv('A', otherAccount.id, csv(ext));
  assert.equal(other.status, 201);
  assert.equal(other.body.data.imported.length, 1, 'a unicidade é por conta');
});

test('M4-G§10 toda linha grava o fingerprint do Guia (sha256 de conta, id externo, data, valor, sentido e descrição); o banco barra a mesma chave na mesma conta mesmo sem passar pelo serviço', async () => {
  const ext = `EXT-Z-${T.uniqueSuffix()}`;
  const r = await importCsv('A', ctx.A.account.id, csv(ext, '-45.60'));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await T.withTenantTransaction(ctx.A.tenant, (t) => BankTransaction.findOne({ where: { externalTransactionId: ext }, transaction: t }));
  assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(row.fingerprint, bankTransactionFingerprint(row));
  await assert.rejects(
    () => T.withTenantTransaction(ctx.A.tenant, (t) => BankTransaction.create({ groupId: ctx.A.tenant.groupId, companyId: ctx.A.tenant.companyId, bankAccountId: ctx.A.account.id, externalTransactionId: ext, amount: 1, transactionDate: new Date() }, { transaction: t })),
    (err) => err.name === 'SequelizeUniqueConstraintError'
  );
  // Linha gravada por SQL direto (carga/ferramenta) recebe o fingerprint pelo gatilho, com a mesma fórmula.
  const rawExt = `EXT-SQL-${T.uniqueSuffix()}`;
  const raw = await T.withTenantTransaction(ctx.A.tenant, async (t) => {
    await T.sequelize.query(
      `INSERT INTO finance.bank_transactions (id, group_id, company_id, bank_account_id, external_transaction_id, amount, transaction_date, description, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, :b, :e, -78.90, '2026-11-10T15:00:00Z', '  Tarifa   Mensal ', now(), now())`,
      { replacements: { g: ctx.A.tenant.groupId, c: ctx.A.tenant.companyId, b: ctx.A.account.id, e: rawExt }, transaction: t }
    );
    return BankTransaction.findOne({ where: { externalTransactionId: rawExt }, transaction: t });
  });
  assert.equal(raw.fingerprint, bankTransactionFingerprint(raw), 'SQL e aplicação calculam o mesmo fingerprint');
  const [idx] = await T.sequelize.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'finance' AND tablename = 'bank_transactions' AND indexdef ILIKE '%UNIQUE%' ORDER BY 1");
  const names = idx.map((i) => i.indexname);
  assert.ok(names.includes('bank_transactions_account_external_id_uk'), names.join(','));
  assert.ok(names.includes('bank_transactions_account_fingerprint_uk'), names.join(','));
  assert.ok(!names.some((n) => /external_transaction_id_key$/.test(n)), 'sem unicidade global do id externo');
});

test('M4-G§10 (mesmo defeito em financial_entries.idempotency_key): a empresa B cria lançamento com a mesma chave de cliente já usada pela empresa A (201); na mesma empresa a chave repetida segue 409 FINANCE_DUPLICATE_PAYMENT', async () => {
  const key = `chave-cliente-${T.uniqueSuffix()}`;
  const body = (cc) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId: cc, description: 'G§10 chave por empresa', idempotencyKey: key });
  const rc = {};
  for (const who of ['A', 'B']) rc[who] = await T.withTenantTransaction(ctx[who].tenant, async (t) => (await T.createTestResultCenter(ctx[who].tenant, t)).id);
  const a = await http('POST', '/finance/entries', ctx.A.token, body(rc.A));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await http('POST', '/finance/entries', ctx.B.token, body(rc.B));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const again = await http('POST', '/finance/entries', ctx.A.token, body(rc.A));
  assert.equal(again.status, 409);
  assert.equal(again.code, 'FINANCE_DUPLICATE_PAYMENT');
});

test('M4-G§10 (mesmo defeito em owner_repasses.idempotency_key): as empresas A e B criam repasse com a mesma chave de cliente (antes a segunda estourava a unicidade global); na mesma empresa a chave repetida segue 409 FINANCE_DUPLICATE_PAYMENT', async () => {
  const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
  const receiptService = require('../src/modules/finance/application/services/receipt.service');
  const ownerRepassesService = require('../src/modules/finance/application/services/owner-repasses.service');
  const propertiesService = require('../src/features/properties/properties.service');
  const { Person } = require('../src/models');
  const key = `repasse-cliente-${T.uniqueSuffix()}`;
  async function repasseIn(who) {
    const tenant = ctx[who].tenant;
    return T.withTenantTransaction(tenant, async (t) => {
      const sfx = T.uniqueSuffix();
      const owner = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `G§10 Proprietário ${sfx}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
      const property = await propertiesService.createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, title: `G§10 Imóvel ${sfx}`, internalCode: `G10-${sfx}`, propertyType: 'RESIDENTIAL' }, tenant.userId, t);
      const rc = await T.createTestResultCenter(tenant, t);
      const rec = await financialEntriesService.createFinancialEntry({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 100, resultCenterId: rc.id, description: `G§10 aluguel ${sfx}` }, tenant.userId, t);
      await receiptService.settleFinancialEntry(rec.id, tenant.userId, t);
      return ownerRepassesService.createOwnerRepasse({ groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id, sourceEntryIds: [rec.id], grossAmount: 100, deductionsAmount: 0, referenceMonth: '2026-11', idempotencyKey: key }, tenant.userId, t);
    });
  }
  const a = await repasseIn('A');
  const b = await repasseIn('B');
  assert.equal(a.idempotencyKey, key);
  assert.equal(b.idempotencyKey, key);
  await assert.rejects(() => repasseIn('A'), (err) => err.code === 'FINANCE_DUPLICATE_PAYMENT');
  const [idx] = await T.sequelize.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'finance' AND tablename IN ('owner_repasses', 'financial_entries') AND indexdef ILIKE '%idempotency_key%'");
  const defs = idx.map((i) => `${i.indexname}: ${i.indexdef}`).join('\n');
  assert.match(defs, /owner_repasses_company_idempotency_uk: .*\(company_id, idempotency_key\)/);
  assert.match(defs, /financial_entries_company_idempotency_uk: .*\(company_id, idempotency_key\)/);
  assert.doesNotMatch(defs, /_idempotency_key_key:/, 'nenhuma unicidade global sobre a chave do cliente');
});
