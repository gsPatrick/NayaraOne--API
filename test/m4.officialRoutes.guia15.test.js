'use strict';

// Guia do Marcelo — Centro Financeiro §15 "APIs mínimas": o livro manda os caminhos literais.
// Defeito achado no fechamento do Marco 4 (10/11/2026): só existiam rotas equivalentes com outros
// nomes. Este arquivo prova, por HTTP real contra o app Express, cada uma das 8 rotas: o caminho
// positivo (2xx) e a recusa (403 sem a permissão; e a recusa de MFA onde a rota equivalente exige).
// MFA recente simulado por linhas no banco descartável (nunca pelo endpoint de MFA).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_GUIA15_TEST_PORT || '21612';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated, FINANCE_ALL } = require('./helpers/m4FinanceHttp');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const settlementEvidence = require('../src/modules/finance/application/services/settlement-evidence.service');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const bankTransactionsService = require('../src/modules/finance/application/services/bank-transactions.service');

let tenant;
let http;
const tk = {};
const users = {};
let costCenterId;
let resultCenterId;
let account;

before(async () => {
  tenant = await isolatedTenant('guia15');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  users.maker = await createUser(tenant, 'preparador');
  users.checker = await createUser(tenant, 'aprovador');
  users.noMfa = await createUser(tenant, 'sem-mfa-recente', 'enabled');
  tk.maker = tokenFor(tenant, users.maker.id);
  tk.checker = tokenFor(tenant, users.checker.id);
  tk.noMfa = tokenFor(tenant, users.noMfa.id);
  tk.readOnly = tokenFor(tenant, users.maker.id, ['finance:read']);
  tk.makerReverse = tokenFor(tenant, users.maker.id, [...FINANCE_ALL, 'finance:reverse']); // Guia §8 / DEC-062: pedir estorno é finance:reverse
  tk.none = tokenFor(tenant, users.maker.id, []);
  await T.withTenantTransaction(tenant, async (t) => {
    costCenterId = (await T.createTestCostCenter(tenant, t)).id;
    resultCenterId = (await T.createTestResultCenter(tenant, t)).id;
    account = await bankAccountsService.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
  });
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

const inTenant = (fn) => T.withTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function payableWithEvidence(label) {
  return inTenant(async (t) => {
    const entry = await financialEntriesService.createFinancialEntry({ ...base(), entryType: 'DEBIT', nature: 'PAYABLE', amount: 123.45, costCenterId, description: `Guia §15 ${label} ${T.uniqueSuffix()}` }, users.maker.id, t);
    const manual = await T.createManualSettlementEvidence(tenant, users.maker.id, t);
    await settlementEvidence.attachSettlementEvidence(entry.id, manual, users.maker.id, t);
    return { entry, manual };
  });
}

async function receivableOnAccount(amount, extra = {}) {
  return inTenant((t) => financialEntriesService.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, bankAccountId: account.id, description: `Guia §15 recebível ${T.uniqueSuffix()}`, ...extra }, users.maker.id, t));
}

async function bankTx(amount, extra = {}) {
  return inTenant((t) => bankTransactionsService.createBankTransaction({ ...base(), bankAccountId: account.id, amount, transactionDate: new Date(), ...extra }, users.maker.id, t));
}

// Fluxo de pagamento usado pelas três primeiras rotas e pelo estorno.
const flow = {};

test('Guia §15 POST /finance/payments/prepare: cria a intenção com snapshot/hash (201); sem finance:create é 403 PERMISSION_DENIED', async () => {
  const { entry, manual } = await payableWithEvidence('prepare');
  Object.assign(flow, { entry, manual });
  const denied = await http('POST', '/finance/payments/prepare', tk.readOnly, { financialEntryId: entry.id });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const ok = await http('POST', '/finance/payments/prepare', tk.maker, { financialEntryId: entry.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.financialEntryId, entry.id);
  assert.match(ok.body.data.snapshotHash, /^[0-9a-f]{64}$/);
  flow.intentId = ok.body.data.id;
});

test('Guia §15 POST /finance/payments/:id/approve: quem preparou não aprova (403); outra pessoa aprova (200); sem finance:approve é 403', async () => {
  assert.ok(flow.intentId, 'depende do teste de prepare');
  const denied = await http('POST', `/finance/payments/${flow.intentId}/approve`, tk.readOnly, {});
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const self = await http('POST', `/finance/payments/${flow.intentId}/approve`, tk.maker, {});
  assert.equal(self.status, 403, JSON.stringify(self.body));
  assert.equal(self.code, 'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN');
  const ok = await http('POST', `/finance/payments/${flow.intentId}/approve`, tk.checker, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'APPROVED');
});

test('Guia §15 POST /finance/payments/:id/execute: sem MFA recente é 403 MFA_STEP_UP_REQUIRED; sem finance:settle é 403; com MFA recente executa (200) e o lançamento fica liquidado', async () => {
  assert.ok(flow.intentId, 'depende dos testes anteriores');
  const body = { settlementEvidenceFileId: flow.manual.evidenceFileId, settlementReason: flow.manual.reason };
  const denied = await http('POST', `/finance/payments/${flow.intentId}/execute`, tk.readOnly, body);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const noMfa = await http('POST', `/finance/payments/${flow.intentId}/execute`, tk.noMfa, body);
  assert.equal(noMfa.status, 403);
  assert.equal(noMfa.code, 'MFA_STEP_UP_REQUIRED');
  const ok = await http('POST', `/finance/payments/${flow.intentId}/execute`, tk.checker, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.intent.status, 'CONFIRMED');
  assert.equal(ok.body.data.entry.status, 'SETTLED');
});

async function confirmationFor(id, token) {
  const impact = await http('GET', `/finance/entries/${id}/impact`, token);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  const d = impact.body.data;
  return { typedCode: d.record.code, justification: 'Estorno de teste do Guia §15: pagamento lançado em duplicidade.', impactToken: d.impactToken };
}

test('Guia §15 POST /finance/ledger/:id/reverse: PEDE o estorno do movimento do ledger com confirmação (202, caso); outra pessoa aprova o caso e o estorno sai (original intacto); fora do ledger é 404; sem finance:reverse é 403', async () => {
  assert.ok(flow.entry, 'depende do teste de execute');
  const denied = await http('POST', `/finance/ledger/${flow.entry.id}/reverse`, tk.readOnly, { reason: 'x' });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const pending = await receivableOnAccount(10);
  const settleOnly = await http('POST', `/finance/ledger/${flow.entry.id}/reverse`, tk.maker, { reason: 'x', confirmation: await confirmationFor(flow.entry.id, tk.maker) });
  assert.equal(settleOnly.status, 403, 'finance:settle não autoriza estorno (DEC-062)');
  const notLedger = await http('POST', `/finance/ledger/${pending.id}/reverse`, tk.makerReverse, { reason: 'Estorno de teste fora do ledger.', confirmation: await confirmationFor(pending.id, tk.makerReverse) });
  assert.equal(notLedger.status, 404, JSON.stringify(notLedger.body));
  assert.equal(notLedger.code, 'FINANCE_LEDGER_MOVEMENT_NOT_FOUND');
  const [inLedger] = await inTenant((t) => T.sequelize.query('SELECT id, amount FROM finance.ledger WHERE id = :id', { replacements: { id: flow.entry.id }, type: T.sequelize.QueryTypes.SELECT, transaction: t }));
  assert.ok(inLedger, 'o pagamento executado está na view finance.ledger');
  const asked = await http('POST', `/finance/ledger/${flow.entry.id}/reverse`, tk.makerReverse, { reason: 'Estorno de teste do Guia §15: pagamento lançado em duplicidade.', confirmation: await confirmationFor(flow.entry.id, tk.makerReverse) });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const ok = await http('POST', `/finance/reversal-cases/${asked.body.data.id}/approve`, tk.checker, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.reversal.idempotencyKey, `reversal:${flow.entry.id}:${asked.body.data.id}`);
  const original = await inTenant((t) => financialEntriesService.getFinancialEntry(flow.entry.id, t));
  assert.equal(original.status, 'REVERSED');
  assert.equal(original.amount, '123.45');
  const compensations = await inTenant((t) => T.sequelize.query('SELECT id, amount, status FROM finance.financial_entries WHERE reversal_of_entry_id = :id', { replacements: { id: flow.entry.id }, type: T.sequelize.QueryTypes.SELECT, transaction: t }));
  assert.equal(compensations.length, 1);
  assert.equal(compensations[0].amount, '123.45');
});

test('Guia §15 GET /finance/reconciliation/pending: fila com a transação de extrato sem conciliação e as pendências de classificação (200); sem finance:read é 403', async () => {
  const tx = await bankTx(77.7, { description: 'Guia §15 extrato sem par' });
  const denied = await http('GET', '/finance/reconciliation/pending', tk.none);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const ok = await http('GET', '/finance/reconciliation/pending?include=suggestions', tk.readOnly);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const item = ok.body.data.bankTransactions.find((b) => b.id === tx.id);
  assert.ok(item, 'a transação sem conciliação está na fila');
  assert.equal(item.pendingType, 'BANK_TRANSACTION_UNMATCHED');
  assert.equal(item.suggestion.finalClass, 'NO_MATCH');
  assert.ok(Array.isArray(ok.body.data.classificationPendings));
  assert.equal(ok.body.data.totals.bankTransactions, ok.body.data.bankTransactions.length);
});

test('Guia §15 POST /finance/reconciliation/:id/confirm: EXATO confirma o candidato do topo (201) e sai da fila; AMBÍGUO/PROVÁVEL exige escolher o lançamento (409); candidato inelegível 409; sem finance:reconcile é 403', async () => {
  const key = `guia15-${T.uniqueSuffix()}`;
  const entry = await receivableOnAccount(150, { idempotencyKey: key });
  const tx = await bankTx(150, { externalTransactionId: key });
  const denied = await http('POST', `/finance/reconciliation/${tx.id}/confirm`, tk.readOnly, {});
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const ok = await http('POST', `/finance/reconciliation/${tx.id}/confirm`, tk.maker, {});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.finalClass, 'EXACT');
  assert.equal(ok.body.data.method, 'HUMAN_CONFIRMED');
  assert.equal(ok.body.data.reconciliation.financialEntryId, entry.id);
  const queue = await http('GET', '/finance/reconciliation/pending', tk.readOnly);
  assert.ok(!queue.body.data.bankTransactions.some((b) => b.id === tx.id), 'conciliada sai da fila');

  const a = await receivableOnAccount(311);
  const b = await receivableOnAccount(311);
  const amb = await bankTx(311);
  const choice = await http('POST', `/finance/reconciliation/${amb.id}/confirm`, tk.maker, {});
  assert.equal(choice.status, 409, JSON.stringify(choice.body));
  assert.equal(choice.code, 'FINANCE_RECONCILIATION_CHOICE_REQUIRED');
  const other = await receivableOnAccount(999);
  const notCandidate = await http('POST', `/finance/reconciliation/${amb.id}/confirm`, tk.maker, { financialEntryId: other.id });
  assert.equal(notCandidate.status, 409);
  assert.equal(notCandidate.code, 'FINANCE_RECONCILIATION_NOT_A_CANDIDATE');
  const chosen = await http('POST', `/finance/reconciliation/${amb.id}/confirm`, tk.maker, { financialEntryId: b.id });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
  assert.equal(chosen.body.data.reconciliation.financialEntryId, b.id);
  assert.notEqual(chosen.body.data.reconciliation.financialEntryId, a.id);
});

test('Guia §15 GET /finance/health: mesmo relatório de saúde de /finance/reports/weekly-health (200); sem finance:read é 403', async () => {
  const denied = await http('GET', '/finance/health', tk.none);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const ok = await http('GET', '/finance/health', tk.readOnly);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const legacy = await http('GET', '/finance/reports/weekly-health', tk.readOnly);
  assert.deepEqual(Object.keys(ok.body.data).sort(), Object.keys(legacy.body.data).sort());
  for (const k of ['freeCash', 'thirdPartyFunds']) assert.ok(k in ok.body.data, `campo ${k} do FinanceHealthReport`);
});

test('Guia §15 POST /finance/periods/:month/close: com as conferências feitas o mês vai para REVIEW (201); mês inválido 400; sem finance:settle é 403', async () => {
  const month = T.uniqueClosingTestMonth();
  await inTenant((t) => T.confirmPeriodChecksForTest(tenant, month, users.maker.id, t));
  const denied = await http('POST', `/finance/periods/${month}/close`, tk.readOnly, {});
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const invalid = await http('POST', '/finance/periods/2026-13/close', tk.maker, {});
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  const ok = await http('POST', `/finance/periods/${month}/close`, tk.maker, {});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'REVIEW');
  assert.equal(ok.body.data.referenceMonth, month);
});
