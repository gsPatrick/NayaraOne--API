'use strict';

// GAP REAL (verificação cética adicional, Marco 4, 12/10/2026): suggestReconciliationMatches
// (as 5 classes do Caderno §11 — EXATO/FORTE/PROVÁVEL/AMBÍGUO/SEM CORRESPONDÊNCIA) já existia
// inteiro no service, mas sem rota HTTP e sem teste dedicado — a tela de conciliação bypassava
// a engine inteira com match ingênuo só por valor. Prova a classificação real aqui e via rota.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.FINANCE_RECON_HTTP_TEST_PORT || '34593';

const app = require('../app');
const { getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');

let tenant;
let baseUrl;
let token;

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['finance:read', 'finance:create', 'finance:reconcile', 'finance:bankAccounts'],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  const { sequelize } = require('./testHelpers');
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function createEntry(transaction, overrides = {}) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 500,
      description: `HOMO QA — reconciliation suggestion ${uniqueSuffix()}`,
      costCenterId: costCenter.id,
      ...overrides,
    },
    tenant.userId,
    transaction
  );
}

test('suggestReconciliationMatches: EXATO quando id externo (idempotencyKey) + conta + data batem', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const idemKey = `recon-${uniqueSuffix()}`;
    const entry = await createEntry(transaction, { amount: 321.0, bankAccountId: account.id, idempotencyKey: idemKey });
    const bankTx = await bankTransactionsService.createBankTransaction(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        amount: 321.0,
        transactionDate: new Date(),
        externalTransactionId: idemKey,
      },
      tenant.userId,
      transaction
    );

    const suggestion = await reconciliationService.suggestReconciliationMatches(bankTx.id, transaction);
    assert.equal(suggestion.finalClass, 'EXACT', `esperava EXACT, veio ${suggestion.finalClass}`);
    assert.equal(suggestion.candidates[0].financialEntryId, entry.id);
  });
});

test('suggestReconciliationMatches: AMBÍGUO quando 2 candidatos empatados na faixa FORTE — nunca resolve sozinho', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const entryA = await createEntry(transaction, { amount: 777.0, bankAccountId: account.id });
    const entryB = await createEntry(transaction, { amount: 777.0, bankAccountId: account.id });
    // Referência (texto da transação) menciona os dois IDs -> sameReference bate pros dois
    // candidatos (não via externalTransactionId, então nenhum vira EXATO — os dois ficam
    // empatados em FORTE: amount .45 + referência .30 + mesma conta .15 = 0.90, cada um).
    const bankTx = await bankTransactionsService.createBankTransaction(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        amount: 777.0,
        transactionDate: new Date(),
        description: `Lote ref ${entryA.id} ${entryB.id}`,
      },
      tenant.userId,
      transaction
    );

    const suggestion = await reconciliationService.suggestReconciliationMatches(bankTx.id, transaction);
    assert.equal(
      suggestion.finalClass,
      'AMBIGUOUS',
      `dois candidatos empatados em FORTE (${entryA.id}/${entryB.id}) deveriam forçar AMBIGUOUS, veio ${suggestion.finalClass}`
    );
    assert.ok(suggestion.candidates.length >= 2);
  });
});

test('suggestReconciliationMatches: SEM CORRESPONDÊNCIA quando nenhum lançamento aberto bate', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 99999.87, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    const suggestion = await reconciliationService.suggestReconciliationMatches(bankTx.id, transaction);
    assert.equal(suggestion.finalClass, 'NO_MATCH');
    assert.equal(suggestion.candidates.length, 0);
  });
});

test('GET /finance/bank-transactions/:id/reconciliation-suggestions responde com a classificação real (rota ponta a ponta)', async () => {
  const suffix = uniqueSuffix();
  const accountRes = await http('POST', '/finance/bank-accounts', {
    bankCode: '001', agency: '0001', accountNumber: `http-recon-${suffix}`,
  });
  assert.equal(accountRes.status, 201, JSON.stringify(accountRes.body));
  const accountId = accountRes.body.data.id;

  const ccRes = await http('POST', '/finance/cost-centers', { code: `CC-HTTP-${suffix}`, name: `Centro de custo HTTP ${suffix}` });
  assert.equal(ccRes.status, 201, JSON.stringify(ccRes.body));

  const entryRes = await http('POST', '/finance/entries', {
    entryType: 'DEBIT', nature: 'PAYABLE', amount: 456.78,
    description: `HOMO QA HTTP recon ${suffix}`, bankAccountId: accountId, costCenterId: ccRes.body.data.id,
  });
  assert.equal(entryRes.status, 201, JSON.stringify(entryRes.body));

  const txRes = await http('POST', '/finance/bank-transactions', {
    bankAccountId: accountId, amount: 456.78, transactionDate: new Date().toISOString(),
  });
  assert.equal(txRes.status, 201, JSON.stringify(txRes.body));

  const suggestRes = await http('GET', `/finance/bank-transactions/${txRes.body.data.id}/reconciliation-suggestions`);
  assert.equal(suggestRes.status, 200, JSON.stringify(suggestRes.body));
  assert.ok(suggestRes.body.data.finalClass);
  assert.ok(Array.isArray(suggestRes.body.data.candidates));
});
