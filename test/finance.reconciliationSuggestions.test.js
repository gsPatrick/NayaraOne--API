'use strict';

// GAP REAL (verificação cética adicional, Marco 4, 12/10/2026): suggestReconciliationMatches
// (as 5 classes do Caderno §11 — EXATO/FORTE/PROVÁVEL/AMBÍGUO/SEM CORRESPONDÊNCIA) já existia
// inteiro no service, mas sem rota HTTP e sem teste dedicado — a tela de conciliação bypassava
// a engine inteira com match ingênuo só por valor. Prova a classificação real aqui e via rota.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.FINANCE_RECON_HTTP_TEST_PORT || '21594';

require('../app');
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
        amount: -321.0,
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
        amount: -777.0,
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
    bankAccountId: accountId, amount: -456.78, transactionDate: new Date().toISOString(),
  });
  assert.equal(txRes.status, 201, JSON.stringify(txRes.body));

  const suggestRes = await http('GET', `/finance/bank-transactions/${txRes.body.data.id}/reconciliation-suggestions`);
  assert.equal(suggestRes.status, 200, JSON.stringify(suggestRes.body));
  assert.ok(suggestRes.body.data.finalClass);
  assert.ok(Array.isArray(suggestRes.body.data.candidates));
});

// --- R6 (reconferência ao vivo 20/10/2026): as 5 classes aparecem de fato -----------------------

async function newAccount(transaction) {
  return bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `${uniqueSuffix()}` },
    tenant.userId,
    transaction
  );
}

function newBankTx(transaction, account, overrides) {
  return bankTransactionsService.createBankTransaction(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, transactionDate: new Date(), ...overrides },
    tenant.userId,
    transaction
  );
}

test('R6 FORTE: valor + referência (texto) + mesma conta + data = 1 candidato só; não vira EXATO sem ID externo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await newAccount(transaction);
    const entry = await createEntry(transaction, { amount: 410.0, bankAccountId: account.id });
    const tx = await newBankTx(transaction, account, { amount: -410.0, description: `PIX ref ${entry.id}` });
    const s = await reconciliationService.suggestReconciliationMatches(tx.id, transaction);
    assert.equal(s.finalClass, 'STRONG');
    assert.equal(s.candidates.length, 1);
    assert.ok(s.candidates[0].score >= 0.9);
    assert.ok(s.candidates[0].reasons.includes('Valor igual'));
  });
});

test('R6 PROVÁVEL: 0,85 (valor + referência + janela, sem conta) continua sugestão; 1 candidato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await newAccount(transaction);
    const entry = await createEntry(transaction, { amount: 411.0 });
    const tx = await newBankTx(transaction, account, { amount: -411.0, description: `PIX ref ${entry.id}` });
    const s = await reconciliationService.suggestReconciliationMatches(tx.id, transaction);
    assert.equal(s.finalClass, 'PROBABLE');
    assert.equal(s.candidates[0].score, 0.85);
  });
});

test('R6 AMBÍGUO: 2 lançamentos de mesmo valor (só valor+data) NÃO são "Provável" — são ambíguos e nunca auto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await newAccount(transaction);
    await createEntry(transaction, { amount: 412.0 });
    await createEntry(transaction, { amount: 412.0 });
    const tx = await newBankTx(transaction, account, { amount: -412.0 });
    const s = await reconciliationService.suggestReconciliationMatches(tx.id, transaction);
    assert.equal(s.finalClass, 'AMBIGUOUS');
    assert.equal(s.candidates.length, 2);
    const auto = await reconciliationService.autoReconcileSuggestion(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankTransactionId: tx.id }, tenant.userId, transaction
    );
    assert.equal(auto.autoReconciled, false);
  });
});

test('R6: FORTE não confirma sozinho por padrão; EXATO confirma e informa método AUTO_EXACT', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await newAccount(transaction);
    const strongEntry = await createEntry(transaction, { amount: 413.0, bankAccountId: account.id });
    const strongTx = await newBankTx(transaction, account, { amount: -413.0, description: `ref ${strongEntry.id}` });
    const a = await reconciliationService.autoReconcileSuggestion(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankTransactionId: strongTx.id }, tenant.userId, transaction
    );
    assert.equal(a.finalClass, 'STRONG');
    assert.equal(a.autoReconciled, false, 'FORTE só confirma sozinho com a política ligada');

    const key = `r6-${uniqueSuffix()}`;
    const exactEntry = await createEntry(transaction, { amount: 414.0, bankAccountId: account.id, idempotencyKey: key });
    const exactTx = await newBankTx(transaction, account, { amount: -414.0, externalTransactionId: key });
    const b = await reconciliationService.autoReconcileSuggestion(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankTransactionId: exactTx.id }, tenant.userId, transaction
    );
    assert.equal(b.finalClass, 'EXACT');
    assert.equal(b.autoReconciled, true);
    assert.equal(b.method, 'AUTO_EXACT');
    assert.equal(b.reconciliation.financialEntryId, exactEntry.id);
  });
});

test('R6: valor divergente, sinal oposto e outra conta nunca conciliam (nem aparecem como sugestão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await newAccount(transaction);
    const other = await newAccount(transaction);
    const wrongAmount = await createEntry(transaction, { amount: 415.0, bankAccountId: account.id });
    const payable = await createEntry(transaction, { amount: 416.0, bankAccountId: account.id });
    const otherAccountEntry = await createEntry(transaction, { amount: 417.0, bankAccountId: other.id });

    const txAmount = await newBankTx(transaction, account, { amount: -415.5, description: `ref ${wrongAmount.id}` });
    assert.equal((await reconciliationService.suggestReconciliationMatches(txAmount.id, transaction)).finalClass, 'NO_MATCH');
    await assert.rejects(
      () => reconciliationService.matchReconciliation({ groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: wrongAmount.id, bankTransactionId: txAmount.id }, tenant.userId, transaction),
      (e) => e.code === 'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );

    const txCredit = await newBankTx(transaction, account, { amount: 416.0 });
    assert.equal((await reconciliationService.suggestReconciliationMatches(txCredit.id, transaction)).finalClass, 'NO_MATCH');
    await assert.rejects(
      () => reconciliationService.matchReconciliation({ groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: payable.id, bankTransactionId: txCredit.id }, tenant.userId, transaction),
      (e) => e.code === 'FINANCE_RECONCILIATION_DIRECTION_MISMATCH'
    );

    const txOther = await newBankTx(transaction, account, { amount: -417.0 });
    assert.equal((await reconciliationService.suggestReconciliationMatches(txOther.id, transaction)).finalClass, 'NO_MATCH');
    await assert.rejects(
      () => reconciliationService.matchReconciliation({ groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: otherAccountEntry.id, bankTransactionId: txOther.id }, tenant.userId, transaction),
      (e) => e.code === 'FINANCE_RECONCILIATION_ACCOUNT_MISMATCH'
    );
  });
});
