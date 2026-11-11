'use strict';

// Caderno M4 §2 FIN-008 ("Sem float — moeda usa numeric/decimal") e precisão até o centavo
// (M4-03; revisão 19/10, A18). Defeito achado na captura ao vivo do fechamento do Marco 4
// (10/11/2026): POST /finance/entries com amount 1.005 era aceito e gravado 1.01. Agora toda
// entrada HTTP de dinheiro do Financeiro recusa mais de 2 casas (400
// FINANCE_AMOUNT_PRECISION_INVALID) e nada é gravado. HTTP real contra o app.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_PRECISAO_TEST_PORT || '21615';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client } = require('./helpers/m4FinanceHttp');
const { hasAtMostTwoDecimals } = require('../src/features/finance/moneyPrecision');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const { FinancialEntry } = require('../src/models');

let tenant;
let http;
let token;
let costCenterId;
let resultCenterId;
let account;

before(async () => {
  tenant = await T.getSeedTenant();
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  token = tokenFor(tenant, (await createUser(tenant, 'centavo')).id);
  await T.withTenantTransaction(tenant, async (t) => {
    costCenterId = (await T.createTestCostCenter(tenant, t)).id;
    resultCenterId = (await T.createTestResultCenter(tenant, t)).id;
    account = await bankAccountsService.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '237', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
  });
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await T.sequelize.close();
  process.exit(0);
});

const expectPrecision = (r, field) => {
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.code, 'FINANCE_AMOUNT_PRECISION_INVALID');
  assert.equal(r.body.error.details.field, field);
  assert.match(r.body.error.message, /mais de 2 casas decimais/);
};

test('M4-FIN-008 POST /finance/entries com 1.005 (número ou texto) é 400 FINANCE_AMOUNT_PRECISION_INVALID e nada é gravado; 1.01 e 1.000 são aceitos e gravados exatamente', async () => {
  const desc = `FIN-008 ${T.uniqueSuffix()}`;
  expectPrecision(await http('POST', '/finance/entries', token, { entryType: 'DEBIT', nature: 'PAYABLE', amount: 1.005, costCenterId, description: desc }), 'amount');
  expectPrecision(await http('POST', '/finance/entries', token, { entryType: 'DEBIT', nature: 'PAYABLE', amount: '1.005', costCenterId, description: desc }), 'amount');
  const none = await T.withTenantTransaction(tenant, (t) => FinancialEntry.count({ where: { description: desc }, transaction: t }));
  assert.equal(none, 0, 'nenhum lançamento arredondado foi gravado');
  const ok = await http('POST', '/finance/entries', token, { entryType: 'DEBIT', nature: 'PAYABLE', amount: 1.01, costCenterId, description: `${desc} ok` });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.amount, '1.01');
  const zeros = await http('POST', '/finance/entries', token, { entryType: 'DEBIT', nature: 'PAYABLE', amount: '1.000', costCenterId, description: `${desc} zeros` });
  assert.equal(zeros.status, 201, JSON.stringify(zeros.body));
  assert.equal(zeros.body.data.amount, '1.00');
});

test('M4-FIN-008 as demais entradas de dinheiro do Financeiro recusam mais de 2 casas: baixa parcial, extrato avulso, repasse (bruto e dedução), intercompany e orçamento', async () => {
  const entry = await T.withTenantTransaction(tenant, (t) => financialEntriesService.createFinancialEntry({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId, description: `FIN-008 parcial ${T.uniqueSuffix()}` }, tenant.userId, t));
  expectPrecision(await http('POST', `/finance/entries/${entry.id}/settle-partial`, token, { partialAmount: 0.105, idempotencyKey: `fin008-${T.uniqueSuffix()}` }), 'partialAmount');
  expectPrecision(await http('POST', '/finance/bank-transactions', token, { bankAccountId: account.id, amount: '12.345', transactionDate: '2026-11-10' }), 'amount');
  expectPrecision(await http('POST', '/finance/owner-repasses', token, { propertyId: account.id, ownerPersonId: account.id, grossAmount: 100.001 }), 'grossAmount');
  expectPrecision(await http('POST', '/finance/owner-repasses', token, { propertyId: account.id, ownerPersonId: account.id, grossAmount: 100, deductionsAmount: '5.555' }), 'deductionsAmount');
  expectPrecision(await http('POST', '/finance/intercompany-transfers', token, { toCompanyId: tenant.companyId, amount: 50.555, reason: 'teste de precisão' }), 'amount');
  expectPrecision(await http('POST', '/finance/budget-forecasts', token, { competenceMonth: '2027-01', nature: 'PAYABLE', costCenterId, forecastedAmount: 999.999 }), 'forecastedAmount');
  const children = await T.withTenantTransaction(tenant, (t) => FinancialEntry.count({ where: { parentEntryId: entry.id }, transaction: t }));
  assert.equal(children, 0);
});

test('M4-FIN-008 regra de centavo: aceita até 2 casas (inclusive zeros à direita e inteiros) e recusa a 3ª casa significativa', () => {
  for (const ok of [1, 1.1, 1.01, '1.01', '1.010', '-25.50', 0.3, 1234567.89, '100']) assert.equal(hasAtMostTwoDecimals(ok), true, String(ok));
  for (const bad of [1.005, '1.005', 0.001, '-25.505', 1234567.891, '0.123']) assert.equal(hasAtMostTwoDecimals(bad), false, String(bad));
});
