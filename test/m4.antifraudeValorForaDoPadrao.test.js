'use strict';

// Caderno M4 §17 (FIN-013): "Valor fora do padrão -> Anomaly score + revisão" (§17.5) e
// "Fornecedor novo de alto valor -> Due diligence/aprovação" (§17.6). Defeito achado na captura
// ao vivo do fechamento do Marco 4 (10/11/2026): flagAnomalousPayment nunca era chamado pelo
// fluxo real — um PAYABLE de R$ 30.000 numa conta com histórico baixo nascia sem retenção e sem
// caso. HTTP real contra o app; MFA recente simulado por linhas no banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_ANTIFRAUDE_TEST_PORT || '21613';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const { FinancialEntry, AnomalyCase } = require('../src/models');

let tenant;
let http;
const tk = {};
let costCenterId;

before(async () => {
  tenant = await isolatedTenant('antifraude');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  const maker = await createUser(tenant, 'af-preparador');
  const checker = await createUser(tenant, 'af-revisor');
  const noMfa = await createUser(tenant, 'af-sem-mfa', 'enabled');
  tk.maker = tokenFor(tenant, maker.id);
  tk.checker = tokenFor(tenant, checker.id);
  tk.noMfa = tokenFor(tenant, noMfa.id);
  costCenterId = await T.withTenantTransaction(tenant, async (t) => (await T.createTestCostCenter(tenant, t)).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

const inTenant = (fn) => T.withTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function newAccount() {
  return inTenant((t) => bankAccountsService.createBankAccount({ ...base(), bankCode: '341', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t));
}

// Histórico: pagamentos já liquidados (baixos) para a mesma conta de destino.
async function settledHistory(bankAccountId, amounts) {
  await inTenant(async (t) => {
    for (const amount of amounts) {
      await FinancialEntry.create({ ...base(), bankAccountId, costCenterId, entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `Histórico ${T.uniqueSuffix()}`, status: 'SETTLED', settledAt: new Date(), competenceMonth: new Date().toISOString().slice(0, 7) }, { transaction: t });
    }
  });
}

const payable = (amount, extra = {}) => http('POST', '/finance/entries', tk.maker, { entryType: 'DEBIT', nature: 'PAYABLE', amount, costCenterId, description: `§17 ${amount} ${T.uniqueSuffix()}`, ...extra });
const casesOf = async (entryId) => (await http('GET', '/finance/anomaly-cases', tk.maker)).body.data.filter((c) => c.relatedEntityId === entryId);

// Roda primeiro: a empresa isolada ainda não tem pagamento liquidado na categoria, então o valor fora do padrão não pontua (DI-DEC007-3) e a preparação
// segue (o achado de conta nova é de revisão, não bloqueia).
test('M4-§17.5 lançamento que nasceu sem avaliação (legado/outro módulo) é avaliado ao preparar a intenção, sem duplicar caso no pedido de aprovação, e o envio ao banco do pagamento retido é recusado', async () => {
  const fresh = await newAccount();
  const legacy = await inTenant((t) => FinancialEntry.create({ ...base(), bankAccountId: fresh.id, costCenterId, entryType: 'DEBIT', nature: 'PAYABLE', amount: '25000.00', description: `Legado ${T.uniqueSuffix()}`, status: 'PENDING', competenceMonth: new Date().toISOString().slice(0, 7) }, { transaction: t }));
  assert.equal(legacy.requiresManualReview, false);
  const prepared = await http('POST', '/finance/payments/prepare', tk.maker, { financialEntryId: legacy.id });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const flagged = await inTenant((t) => FinancialEntry.findByPk(legacy.id, { transaction: t }));
  assert.equal(flagged.requiresManualReview, true);
  const approval = await http('POST', '/finance/approval-requests', tk.maker, { relatedEntityType: 'FinancialEntry', relatedEntityId: legacy.id, riskLevel: 'HIGH' });
  assert.ok([200, 201].includes(approval.status), JSON.stringify(approval.body));
  // DI-DEC007-6: o primeiro pagamento alto a conta sem histórico é o caso NEW_ACCOUNT_IMMEDIATE_PAYMENT (MEDIUM, retém sem bloquear a preparação).
  const cases = await inTenant((t) => AnomalyCase.findAll({ where: { relatedEntityId: legacy.id, caseType: 'NEW_ACCOUNT_IMMEDIATE_PAYMENT' }, transaction: t }));
  assert.equal(cases.length, 1, 'um caso só');
  const approved = await http('POST', `/finance/payments/${prepared.body.data.id}/approve`, tk.checker, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const toBank = await http('POST', `/finance/payment-intents/${prepared.body.data.id}/submit-to-bank`, tk.checker, { paymentMethod: 'TED' });
  assert.equal(toBank.status, 409, JSON.stringify(toBank.body));
  assert.equal(toBank.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
});

// DEC-007 (DI-DEC007-3 e DI-DEC007-6): 30.000 sobre a mediana 100 de 5 pagamentos é 300x, acima do múltiplo que bloqueia (10,0) => caso AMOUNT_OUTLIER
// HIGH, bloqueante; a conta recém-cadastrada recebendo a partir de R$ 20.000,00 também abre NEW_SUPPLIER_HIGH_VALUE (fornecedor novo de alto valor).
test('M4-§17.5 valor fora do padrão: PAYABLE de 30.000 numa conta com histórico de 100 nasce retido e bloqueado, com caso AMOUNT_OUTLIER HIGH (e fornecedor novo) em GET /finance/anomaly-cases; valor dentro do padrão não retém', async () => {
  const account = await newAccount();
  await settledHistory(account.id, ['100.00', '100.00', '100.00', '100.00', '100.00']);
  const outlier = await payable(30000, { bankAccountId: account.id });
  assert.equal(outlier.status, 201, JSON.stringify(outlier.body));
  assert.equal(outlier.body.data.requiresManualReview, true);
  assert.match(outlier.body.data.manualReviewReason, /300\.0x a mediana \(100\.00\)/);
  const cases = (await casesOf(outlier.body.data.id)).sort((x, y) => x.caseType.localeCompare(y.caseType));
  assert.deepEqual(cases.map((c) => [c.caseType, c.riskLevel, c.status]), [['AMOUNT_OUTLIER', 'HIGH', 'OPEN'], ['NEW_SUPPLIER_HIGH_VALUE', 'MEDIUM', 'OPEN']]);
  const normal = await payable(150, { bankAccountId: account.id });
  assert.equal(normal.status, 201);
  assert.equal(normal.body.data.requiresManualReview, false);
  assert.equal((await casesOf(normal.body.data.id)).length, 0);
});

test('M4-§17.5 pagamento retido não liquida (409 FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW) até a liberação humana com MFA; liberado, preparar a intenção não abre outro caso', async () => {
  const account = await newAccount();
  await settledHistory(account.id, ['200.00', '220.00', '210.00', '205.00', '215.00']);
  const entry = (await payable(30000, { bankAccountId: account.id })).body.data;
  assert.equal(entry.requiresManualReview, true);
  const settle = await http('POST', `/finance/entries/${entry.id}/settle`, tk.maker, {});
  assert.equal(settle.status, 409, JSON.stringify(settle.body));
  assert.equal(settle.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
  const noMfa = await http('POST', `/finance/entries/${entry.id}/clear-manual-review`, tk.noMfa, { reviewNote: 'Conferido com o fornecedor.' });
  assert.equal(noMfa.status, 403);
  assert.equal(noMfa.code, 'MFA_STEP_UP_REQUIRED');
  const cleared = await http('POST', `/finance/entries/${entry.id}/clear-manual-review`, tk.checker, { reviewNote: 'Conferido com o fornecedor por telefone e nota fiscal.' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.data.requiresManualReview, false);
  const prepared = await http('POST', '/finance/payments/prepare', tk.maker, { financialEntryId: entry.id });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const after = await inTenant((t) => FinancialEntry.findByPk(entry.id, { transaction: t }));
  assert.equal(after.requiresManualReview, false, 'liberado pelo revisor não é retido de novo pelo mesmo fato');
  assert.equal((await casesOf(entry.id)).length, 2, 'os dois casos da criação (valor fora do padrão e fornecedor novo), nenhum a mais');
});

test('M4-§17.5 (§17.6 fornecedor novo de alto valor): primeiro pagamento de 15.000 para conta sem histórico fica retido; conta definida depois (PATCH) também é avaliada', async () => {
  const fresh = await newAccount();
  const first = await payable(15000, { bankAccountId: fresh.id });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.requiresManualReview, true);
  assert.match(first.body.data.manualReviewReason, /Primeiro pagamento/);
  const noAccount = await payable(20000);
  assert.equal(noAccount.body.data.requiresManualReview, false, 'sem conta de destino ainda não há o que avaliar');
  const other = await newAccount();
  const patched = await http('PATCH', `/finance/entries/${noAccount.body.data.id}`, tk.maker, { bankAccountId: other.id });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const reloaded = await inTenant((t) => FinancialEntry.findByPk(noAccount.body.data.id, { transaction: t }));
  assert.equal(reloaded.requiresManualReview, true);
  // DEC-007: 20.000 numa conta recém-cadastrada também é fornecedor novo de alto valor (a partir de R$ 20.000,00); a conta sem histórico é comparada com a
  // categoria da empresa, que já tem os 10 pagamentos baixos dos testes anteriores (DI-DEC007-3): valor fora do padrão também.
  assert.equal((await casesOf(reloaded.id)).map((c) => c.caseType).sort().join(','), 'AMOUNT_OUTLIER,NEW_ACCOUNT_IMMEDIATE_PAYMENT,NEW_SUPPLIER_HIGH_VALUE');
});

