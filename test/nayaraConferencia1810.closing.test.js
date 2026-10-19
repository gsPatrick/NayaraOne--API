'use strict';

// F02 — fechamento do mês, 2ª rodada (revisor independente da conferência Nayara 18/10/2026,
// Maturacao/CONFERENCIA_MARCOS4_5_18-10_CHECKLIST.md). Cada teste reproduz uma brecha provada
// pelo revisor contra o Postgres e falha no código anterior (46b0ecb).
//
// Meses de teste: os testes em transação com rollback usam meses de 1980-1999 sem fechamento
// registrado (o caixa é contado pela data de liquidação, e nada real foi liquidado nessa época,
// então nenhum dado do banco compartilhado interfere). Item 7: NENHUM teste commita pedido de
// fechamento, fechamento ou snapshot — a concorrência é provada com duas transações que terminam
// em ROLLBACK (lock_timeout), e o teste HTTP só exercita caminhos que recusam sem gravar.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.CONFERENCIA_1810_CLOSING_HTTP_TEST_PORT || '21631';

const app = require('../app');
const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestResultCenter,
  createTestCostCenter,
  settleFinancialEntryWithApproval,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { encryptSecret } = require('../src/utils/mfaCrypto');
const {
  User,
  Person,
  Contract,
  ContractParty,
  BankAccount,
  PeriodClosure,
  PeriodClosureSnapshot,
  MfaCredential,
  MfaStepUp,
} = require('../src/models');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const periodClosuresService = require('../src/features/finance/periodClosures.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankPaymentsService = require('../src/features/finance/bankPayments.service');

const COMMITTED_CONCURRENCY_MONTH = '2002-01';
const COMMITTED_HTTP_MONTH = '2002-02';

let tenant;
let baseUrl;
let approverA;
let approverB;
let mfaApprover;

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

async function expectPreconditionMissing(promise, expectedCodes) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'FINANCE_PERIOD_PRECONDITIONS_NOT_MET', err.message);
    const missing = ((err.details && err.details.missing) || []).map((m) => m.code).sort();
    assert.deepEqual(missing, [...expectedCodes].sort(), err.message);
    return true;
  });
}

async function freeMonth(transaction) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const year = 1980 + Math.floor(Math.random() * 20);
    const month = `${year}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}`;
    const existing = await PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth: month }, transaction });
    if (!existing) return month;
  }
  throw new Error('Não achei mês livre para o teste.');
}

async function confirmChecks(referenceMonth, actorUserId, transaction) {
  for (const checkType of ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES']) {
    await periodClosuresService.confirmPeriodCheck(
      withTenant({ referenceMonth, checkType, note: `Conferência de teste (${checkType})` }),
      actorUserId,
      transaction
    );
  }
}

async function createBankAccount(transaction) {
  return BankAccount.create(
    withTenant({ bankCode: '001', agency: '0001', accountNumber: `CLS-${uniqueSuffix()}`, pixKey: `cls-${uniqueSuffix()}@nayaraone.dev`, status: 'ACTIVE' }),
    { transaction }
  );
}

// Data de liquidação dentro do mês de referência. O serviço grava settled_at = agora; o teste
// leva o fato de caixa para o mês testado (settled_at é coluna mutável do ledger por desenho).
async function moveSettlementInto(entryIds, referenceMonth, transaction, day = '15') {
  await sequelize.query(
    'UPDATE finance.financial_entries SET settled_at = :at WHERE id IN (:ids)',
    { replacements: { at: `${referenceMonth}-${day}T15:00:00.000Z`, ids: entryIds }, transaction }
  );
}

async function settledReceivable(transaction, { referenceMonth, amount = 640, bankAccountId = null } = {}) {
  const resultCenter = await createTestResultCenter(tenant, transaction);
  const entry = await financialEntriesService.createFinancialEntry(
    withTenant({
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount,
      description: `CLS recebimento ${uniqueSuffix()}`,
      resultCenterId: resultCenter.id,
      bankAccountId: bankAccountId || undefined,
      dueAt: `${referenceMonth}-15T15:00:00.000Z`,
    }),
    tenant.userId,
    transaction
  );
  await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);
  await moveSettlementInto([entry.id], referenceMonth, transaction);
  return entry;
}

async function leaseWithTenant(transaction) {
  const s = uniqueSuffix();
  const contract = await Contract.create(
    withTenant({ contractType: 'LEASE', contractNumber: `CLS-${s}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId }),
    { transaction }
  );
  const holder = await Person.create(
    withTenant({ personType: 'PF', legalName: `CLS Locatário ${s}`, createdBy: tenant.userId, updatedBy: tenant.userId }),
    { transaction }
  );
  await ContractParty.create(withTenant({ contractId: contract.id, personId: holder.id, partyRole: 'TENANT' }), { transaction });
  return { contract, holder };
}

async function withCommitted(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// Deixa um mês dedicado (commitado) no estado OPEN, qualquer que tenha sido o fim da execução
// anterior (inclusive interrompida no meio).
async function resetDedicatedMonth(referenceMonth) {
  await withCommitted(async (t) => {
    const closure = await PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth }, transaction: t });
    if (closure && closure.status === 'CLOSED') {
      await periodClosuresService.reopenPeriod(withTenant({ referenceMonth, reason: 'Teste automatizado: restaurar mês dedicado' }), approverA.id, t);
    } else if (closure && closure.status === 'REVIEW') {
      await periodClosuresService.returnPeriodToOpen(withTenant({ referenceMonth, reason: 'Teste automatizado: restaurar mês dedicado' }), approverA.id, t);
    }
  });
}

async function userFixture(label) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-closing-${label}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Fechamento ${label}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return user;
}

async function createMfaUser(label) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-closing-${label}-${uniqueSuffix()}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Fechamento ${label}`, passwordHash: 'x', status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP' },
  });
  await withCommitted(async (t) => {
    await MfaCredential.create(
      withTenant({ userId: user.id, secretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP'), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }),
      { transaction: t }
    );
    await MfaStepUp.create(
      withTenant({ userId: user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }),
      { transaction: t }
    );
  });
  return user;
}

function tokenFor(userId, permissions) {
  return signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions });
}

async function http(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

before(async () => {
  tenant = await getSeedTenant();
  approverA = await userFixture('aprovador-a');
  approverB = await userFixture('aprovador-b');
  mfaApprover = await createMfaUser('mfa');
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

// =============================================================================================
// Item 1 — guarda de competência
// =============================================================================================

test('F02-C1: assertCompetenceOpen recusa competência CLOSED e REVIEW, aceita OPEN e ignora vazios', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const closedMonth = await freeMonth(transaction);
    await confirmChecks(closedMonth, tenant.userId, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth: closedMonth }), tenant.userId, transaction);
    await expectCode(periodClosuresService.assertCompetenceOpen(tenant.companyId, closedMonth, transaction), 'FINANCE_PERIOD_IN_REVIEW');
    await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth: closedMonth }), approverA.id, transaction);
    await expectCode(periodClosuresService.assertCompetenceOpen(tenant.companyId, closedMonth, transaction), 'FINANCE_PERIOD_CLOSED');
    // Mover PARA e TIRAR DE: quem chama passa a competência atual e a nova; qualquer uma fechada recusa.
    const openMonth = await freeMonth(transaction);
    await expectCode(periodClosuresService.assertCompetenceOpen(tenant.companyId, [openMonth, closedMonth], transaction), 'FINANCE_PERIOD_CLOSED');
    await expectCode(periodClosuresService.assertCompetenceOpen(tenant.companyId, [closedMonth, openMonth], transaction), 'FINANCE_PERIOD_CLOSED');
    await periodClosuresService.assertCompetenceOpen(tenant.companyId, [openMonth, null, undefined, ''], transaction);
    await expectCode(periodClosuresService.assertCompetenceOpen(tenant.companyId, '2026-13', transaction), 'FINANCE_PERIOD_VALIDATION');
    // A guarda de datas também entende competência "YYYY-MM" diretamente.
    await expectCode(periodClosuresService.assertPeriodOpenForEntry(tenant.companyId, [closedMonth], transaction), 'FINANCE_PERIOD_CLOSED');
  });
});

test('F02-C1b: mês fechado não recebe nem perde lançamento em nenhum caminho (criar, editar, baixar, baixa parcial, estornar)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const closedMonth = await freeMonth(transaction);
    let openMonth = await freeMonth(transaction);
    while (openMonth === closedMonth) openMonth = await freeMonth(transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const receivable = (month, label) =>
      financialEntriesService.createFinancialEntry(
        withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 200, description: `CLS ${label} ${uniqueSuffix()}`, resultCenterId: resultCenter.id, competenceMonth: month, dueAt: `${month}-12T15:00:00.000Z` }),
        tenant.userId,
        transaction
      );
    const insideClosed = await receivable(closedMonth, 'dentro do mês fechado');
    const outside = await receivable(openMonth, 'fora do mês fechado');

    await confirmChecks(closedMonth, tenant.userId, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth: closedMonth }), tenant.userId, transaction);
    await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth: closedMonth }), approverA.id, transaction);

    // Criar com competência fechada.
    await expectCode(receivable(closedMonth, 'novo'), 'FINANCE_PERIOD_CLOSED');
    // Editar: mover PARA o mês fechado e TIRAR do mês fechado.
    await expectCode(
      financialEntriesService.updateFinancialEntry(outside.id, { competenceMonth: closedMonth }, tenant.userId, transaction),
      'FINANCE_PERIOD_CLOSED'
    );
    await expectCode(
      financialEntriesService.updateFinancialEntry(insideClosed.id, { competenceMonth: openMonth }, tenant.userId, transaction),
      'FINANCE_PERIOD_CLOSED'
    );
    await expectCode(
      financialEntriesService.updateFinancialEntry(insideClosed.id, { description: 'edição comum' }, tenant.userId, transaction),
      'FINANCE_PERIOD_CLOSED'
    );
    // Baixar (integral e parcial) e estornar lançamento da competência fechada.
    await expectCode(financialEntriesService.settleFinancialEntry(insideClosed.id, tenant.userId, transaction), 'FINANCE_PERIOD_CLOSED');
    await expectCode(
      financialEntriesService.settleFinancialEntryPartial(insideClosed.id, 50, tenant.userId, transaction),
      'FINANCE_PERIOD_CLOSED'
    );
    await expectCode(
      financialEntriesService.reverseFinancialEntry(insideClosed.id, 'Estorno de teste', tenant.userId, transaction),
      'FINANCE_PERIOD_CLOSED'
    );
    // O lançamento fora do mês fechado segue livre.
    await financialEntriesService.updateFinancialEntry(outside.id, { description: 'edição comum fora' }, tenant.userId, transaction);
  });
});

// =============================================================================================
// Item 2 — período preso em REVIEW
// =============================================================================================

test('F02-C2: conferência desatualizada em REVIEW — o aprovador devolve para OPEN com motivo, reconfere e o mês fecha', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    await confirmChecks(referenceMonth, tenant.userId, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);

    // Depois do pedido, entra uma caução na competência: a conferência fica desatualizada.
    // A competência em REVIEW não aceita lançamento novo (guarda de competência); a caução tem
    // competência noutro mês aberto, mas o dinheiro entra no caixa do mês em revisão.
    const otherMonth = await freeMonth(transaction);
    await expectCode(
      periodClosuresService.assertCompetenceOpen(tenant.companyId, referenceMonth, transaction),
      'FINANCE_PERIOD_IN_REVIEW'
    );
    const { contract, holder } = await leaseWithTenant(transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const deposit = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 100, description: 'CLS caução em revisão', resultCenterId: resultCenter.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: holder.id, competenceMonth: otherMonth, dueAt: `${otherMonth}-10T15:00:00.000Z` }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(deposit.id, tenant.userId, transaction);
    await moveSettlementInto([deposit.id], referenceMonth, transaction);

    await expectPreconditionMissing(
      periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverA.id, transaction),
      ['THIRD_PARTY_CASH_CHECKED']
    );
    // Sem saída antes da correção: conferir só em OPEN, pedir de novo dá ALREADY_IN_REVIEW,
    // reabrir só vale para CLOSED.
    await expectCode(
      periodClosuresService.confirmPeriodCheck(withTenant({ referenceMonth, checkType: 'THIRD_PARTY_CASH', note: 'x' }), tenant.userId, transaction),
      'FINANCE_PERIOD_CHECK_NOT_ALLOWED'
    );
    await expectCode(periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction), 'FINANCE_PERIOD_ALREADY_IN_REVIEW');

    await expectCode(
      periodClosuresService.returnPeriodToOpen(withTenant({ referenceMonth, reason: '  ' }), approverA.id, transaction),
      'FINANCE_PERIOD_RETURN_REASON_REQUIRED'
    );
    const reopened = await periodClosuresService.returnPeriodToOpen(
      withTenant({ referenceMonth, reason: 'Caução recebida depois do pedido — reconferir o caixa de terceiros.' }),
      approverA.id,
      transaction
    );
    assert.equal(reopened.status, 'OPEN');
    assert.equal(reopened.returnedToOpenByUserId, approverA.id);
    assert.equal(reopened.reviewRequestedByUserId, null, 'o pedido seguinte reinicia a segregação');
    await expectCode(
      periodClosuresService.returnPeriodToOpen(withTenant({ referenceMonth, reason: 'de novo' }), approverA.id, transaction),
      'FINANCE_PERIOD_NOT_IN_REVIEW'
    );

    await periodClosuresService.confirmPeriodCheck(
      withTenant({ referenceMonth, checkType: 'THIRD_PARTY_CASH', note: 'Reconferido com a caução de 100.' }),
      tenant.userId,
      transaction
    );
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);
    const closed = await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverA.id, transaction);
    assert.equal(closed.status, 'CLOSED');
  });
});

// =============================================================================================
// Item 3 — pagamento em trânsito
// =============================================================================================

test('F02-C3: intenção de pagamento enviada ao banco e sem resposta bloqueia o fechamento da competência', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    const costCenter = await createTestCostCenter(tenant, transaction);
    const bankAccount = await createBankAccount(transaction);
    const entry = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 300, description: 'CLS pagamento em trânsito', costCenterId: costCenter.id, bankAccountId: bankAccount.id, dueAt: `${referenceMonth}-15T15:00:00.000Z` }),
      tenant.userId,
      transaction
    );
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    await paymentIntentsService.approvePaymentIntent(intent.id, approverA.id, transaction);
    await bankPaymentsService.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);

    await confirmChecks(referenceMonth, tenant.userId, transaction);
    const { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    const inTransit = preconditions.items.find((item) => item.code === 'PAYMENTS_IN_TRANSIT');
    assert.equal(inTransit.ok, false);
    assert.deepEqual(inTransit.paymentIntentIds, [intent.id]);
    await expectPreconditionMissing(
      periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction),
      ['PAYMENTS_IN_TRANSIT']
    );
  });
});

test('F02-C3b: confirmação do banco que chega depois do fechamento liquida no período corrente com aviso POST_CLOSING_BANK_CONFIRMATION', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    const costCenter = await createTestCostCenter(tenant, transaction);
    const bankAccount = await createBankAccount(transaction);
    const entry = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 410.5, description: `CLS confirmação tardia ${uniqueSuffix()}`, costCenterId: costCenter.id, bankAccountId: bankAccount.id, competenceMonth: referenceMonth, dueAt: `${referenceMonth}-20T15:00:00.000Z` }),
      tenant.userId,
      transaction
    );
    // Intenção aprovada mas ainda não enviada: não é "pagamento em trânsito", o mês pode fechar.
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    await paymentIntentsService.approvePaymentIntent(intent.id, approverA.id, transaction);
    await confirmChecks(referenceMonth, tenant.userId, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);
    await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverA.id, transaction);
    await expectCode(periodClosuresService.assertCompetenceOpen(tenant.companyId, referenceMonth, transaction), 'FINANCE_PERIOD_CLOSED');

    // Envio e confirmação do banco só depois do fechamento: o pagamento é FATO consumado — não
    // pode ser recusado pelo mês fechado.
    const submitted = await bankPaymentsService.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);
    const before = Date.now();
    const confirmed = await bankPaymentsService.confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', transaction);
    assert.equal(confirmed.status, 'EXECUTED');

    await entry.reload({ transaction });
    assert.equal(entry.status, 'SETTLED');
    // Referência ao período original preservada; o fato de caixa cai no período corrente (agora).
    assert.equal(entry.competenceMonth, referenceMonth);
    assert.ok(entry.settledAt && new Date(entry.settledAt).getTime() >= before - 60000, 'liquidação datada no período corrente');
    assert.notEqual(new Date(entry.settledAt).toISOString().slice(0, 7), referenceMonth);

    const { AnomalyCase } = require('../src/models');
    const warnings = await AnomalyCase.findAll({ where: { relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, caseType: 'POST_CLOSING_BANK_CONFIRMATION' }, transaction });
    assert.equal(warnings.length, 1, 'abre exatamente um aviso para o contador/revisor');
    assert.ok(warnings[0].reason.includes(referenceMonth));
  });
});

// =============================================================================================
// Item 4 — caixa de terceiros
// =============================================================================================

test('F02-C4a: +500 de caução e −500 de devolução depois da conferência deixam a conferência desatualizada (líquido igual)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    await confirmChecks(referenceMonth, tenant.userId, transaction);

    const { contract, holder } = await leaseWithTenant(transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const deposit = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, description: 'CLS caução', resultCenterId: resultCenter.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: holder.id, dueAt: `${referenceMonth}-05T15:00:00.000Z` }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(deposit.id, tenant.userId, transaction);
    const costCenter = await createTestCostCenter(tenant, transaction);
    const release = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 500, description: 'CLS devolução', costCenterId: costCenter.id, isThirdPartyFunds: true, thirdPartyReference: 'Devolução', thirdPartyOriginEntryId: deposit.id, dueAt: `${referenceMonth}-20T15:00:00.000Z` }),
      tenant.userId,
      transaction
    );
    await settleFinancialEntryWithApproval(tenant, release.id, tenant.userId, transaction);
    await moveSettlementInto([deposit.id, release.id], referenceMonth, transaction);

    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction).catch(() => {});
    const { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    const check = preconditions.items.find((item) => item.code === 'THIRD_PARTY_CASH_CHECKED');
    assert.equal(check.ok, false, `conferência deveria estar desatualizada: ${check.detail}`);
    assert.equal(preconditions.thirdParty.net, '0.00', 'líquido do mês igual ao conferido');
    assert.equal(preconditions.thirdParty.received, '500.00');
    assert.equal(preconditions.thirdParty.released, '500.00');
  });
});

test('F02-C4b: baixa parcial de caução entra no caixa de terceiros e no saldo do fim do mês', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    const { contract, holder } = await leaseWithTenant(transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const deposit = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: 'CLS caução parcial', resultCenterId: resultCenter.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: holder.id, dueAt: `${referenceMonth}-05T15:00:00.000Z` }),
      tenant.userId,
      transaction
    );
    const { settlement } = await financialEntriesService.settleFinancialEntryPartial(deposit.id, 400, tenant.userId, transaction);
    await moveSettlementInto([settlement.id], referenceMonth, transaction);

    const { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    assert.equal(preconditions.thirdParty.received, '400.00', 'a baixa parcial (filha) é dinheiro de terceiro, mesmo sem a marca na filha');
    assert.equal(preconditions.thirdParty.balanceAtMonthEnd, '400.00');
  });
});

// =============================================================================================
// Item 5 — extrato e conciliação
// =============================================================================================

test('F02-C5a: extrato que não cobre o mês inteiro não satisfaz "extratos importados"; cobrindo, satisfaz', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    const bankAccount = await createBankAccount(transaction);
    const receipt = await settledReceivable(transaction, { referenceMonth, amount: 640, bankAccountId: bankAccount.id });

    // Antes da correção bastava UMA transação no mês. Aqui o extrato só vai do dia 5 ao 20.
    const partial = await bankTransactionsService.importBankStatement(
      withTenant({ bankAccountId: bankAccount.id, csvText: `externalTransactionId,transactionDate,description,amount\nCLS-${uniqueSuffix()},${referenceMonth}-15,Aluguel,640.00`, periodStart: `${referenceMonth}-05`, periodEnd: `${referenceMonth}-20` }),
      tenant.userId,
      transaction
    );
    await reconciliationService.matchReconciliation(withTenant({ financialEntryId: receipt.id, bankTransactionId: partial.imported[0].id }), tenant.userId, transaction);
    let { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    let item = preconditions.items.find((i) => i.code === 'BANK_STATEMENTS_IMPORTED');
    assert.equal(item.ok, false, item.detail);
    assert.deepEqual(item.bankAccountIds, [bankAccount.id]);

    const lastDay = new Date(Date.UTC(Number(referenceMonth.slice(0, 4)), Number(referenceMonth.slice(5)), 0)).getUTCDate();
    await bankTransactionsService.importBankStatement(
      withTenant({ bankAccountId: bankAccount.id, csvText: `externalTransactionId,transactionDate,description,amount\n${partial.imported[0].externalTransactionId},${referenceMonth}-15,Aluguel,640.00`, periodStart: `${referenceMonth}-01`, periodEnd: `${referenceMonth}-${lastDay}`, closingBalance: '640.00' }),
      tenant.userId,
      transaction
    );
    ({ preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction));
    item = preconditions.items.find((i) => i.code === 'BANK_STATEMENTS_IMPORTED');
    assert.equal(item.ok, true, item.detail);

    await expectCode(
      bankTransactionsService.importBankStatement(
        withTenant({ bankAccountId: bankAccount.id, csvText: `externalTransactionId,transactionDate,description,amount\nCLS-${uniqueSuffix()},${referenceMonth}-25,Fora,1.00`, periodStart: `${referenceMonth}-01`, periodEnd: `${referenceMonth}-20` }),
        tenant.userId,
        transaction
      ),
      'FINANCE_BANK_STATEMENT_IMPORT_LINE_OUTSIDE_PERIOD'
    );
  });
});

test('F02-C5b: movimento de caixa bancário do mês sem conciliação bloqueia, mesmo sem linha de extrato pendente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    const bankAccount = await createBankAccount(transaction);
    const reconciled = await settledReceivable(transaction, { referenceMonth, amount: 640, bankAccountId: bankAccount.id });
    const notInStatement = await settledReceivable(transaction, { referenceMonth, amount: 77, bankAccountId: bankAccount.id });

    const lastDay = new Date(Date.UTC(Number(referenceMonth.slice(0, 4)), Number(referenceMonth.slice(5)), 0)).getUTCDate();
    const imported = await bankTransactionsService.importBankStatement(
      withTenant({ bankAccountId: bankAccount.id, csvText: `externalTransactionId,transactionDate,description,amount\nCLS-${uniqueSuffix()},${referenceMonth}-15,Aluguel,640.00`, periodStart: `${referenceMonth}-01`, periodEnd: `${referenceMonth}-${lastDay}` }),
      tenant.userId,
      transaction
    );
    await reconciliationService.matchReconciliation(withTenant({ financialEntryId: reconciled.id, bankTransactionId: imported.imported[0].id }), tenant.userId, transaction);
    await confirmChecks(referenceMonth, tenant.userId, transaction);

    const { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    const item = preconditions.items.find((i) => i.code === 'RECONCILIATION_PENDINGS');
    assert.equal(item.unreconciledStatementLines, 0, 'nenhuma linha de extrato pendente');
    assert.deepEqual(item.unreconciledEntryIds, [notInStatement.id], 'o recebimento que não apareceu no extrato fica pendente');
    await expectPreconditionMissing(
      periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction),
      ['RECONCILIATION_PENDINGS']
    );
  });
});

// =============================================================================================
// Item 6 — segregação, fuso, TRUNCATE, concorrência
// =============================================================================================

test('F02-C6a: quem registrou uma conferência não aprova o fechamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    await periodClosuresService.confirmPeriodCheck(withTenant({ referenceMonth, checkType: 'THIRD_PARTY_CASH', note: 'ok' }), approverA.id, transaction);
    await periodClosuresService.confirmPeriodCheck(withTenant({ referenceMonth, checkType: 'COMMISSIONS_REPASSES', note: 'ok' }), tenant.userId, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);
    await expectCode(
      periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverA.id, transaction),
      'FINANCE_PERIOD_CHECKER_APPROVAL_BLOCKED'
    );
    const closed = await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverB.id, transaction);
    assert.equal(closed.status, 'CLOSED');
  });
});

test('F02-C6b: limites do mês no fuso de São Paulo — 22h do dia 31 em Brasília é do próprio mês', async () => {
  assert.equal(periodClosuresService.toReferenceMonth('2026-10-31T22:00:00-03:00'), '2026-10');
  assert.equal(periodClosuresService.toReferenceMonth('2026-11-01T00:30:00-03:00'), '2026-11');
  assert.equal(periodClosuresService.toReferenceMonth('2026-11-01'), '2026-11', 'data de calendário não sofre conversão');
  assert.equal(periodClosuresService.toReferenceMonth('2026-11'), '2026-11');

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = await freeMonth(transaction);
    const bankAccount = await createBankAccount(transaction);
    const receipt = await settledReceivable(transaction, { referenceMonth, amount: 50, bankAccountId: bankAccount.id });
    const [year, month] = referenceMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    // 22h do último dia em São Paulo = 01h UTC do dia 1º do mês seguinte.
    const lateNight = new Date(Date.UTC(year, month - 1, lastDay, 22 + 3)).toISOString();
    await sequelize.query('UPDATE finance.financial_entries SET settled_at = :at WHERE id = :id', { replacements: { at: lateNight, id: receipt.id }, transaction });
    const { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    const item = preconditions.items.find((i) => i.code === 'RECONCILIATION_PENDINGS');
    assert.deepEqual(item.unreconciledEntryIds, [receipt.id], 'o caixa das 22h do dia 31 pertence ao mês do dia 31');
  });
});

test('F02-C6c: snapshot do fechamento recusa TRUNCATE (trigger de instrução no banco)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const [rows] = await sequelize.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'finance.period_closure_snapshots'::regclass AND tgname = 'trg_period_closure_snapshots_no_truncate' AND (tgtype & 32) = 32",
      { transaction }
    );
    assert.equal(rows.length, 1, 'trigger BEFORE TRUNCATE presente');
    await sequelize.query('SAVEPOINT cls_truncate', { transaction });
    await assert.rejects(() => sequelize.query('TRUNCATE finance.period_closure_snapshots', { transaction }));
    await sequelize.query('ROLLBACK TO SAVEPOINT cls_truncate', { transaction });
  });
});

test('F02-C6d: aprovação trava a linha do período (FOR UPDATE) — uma segunda aprovação simultânea espera, sem commit', async () => {
  // Item 7: nada de fechamento commitado. Uma linha OPEN do mês dedicado já existe (ou é criada
  // OPEN, que não é fechamento). T1 pede o fechamento sem commitar (segura o lock da linha); T2
  // tenta aprovar com lock_timeout curto: sem FOR UPDATE a leitura passaria direto (MVCC) e
  // responderia NOT_IN_REVIEW; com FOR UPDATE ela espera a linha e estoura o lock_timeout.
  // As duas transações terminam em ROLLBACK.
  const referenceMonth = COMMITTED_CONCURRENCY_MONTH;
  await resetDedicatedMonth(referenceMonth);
  await withCommitted((t) =>
    PeriodClosure.findOrCreate({
      where: { companyId: tenant.companyId, referenceMonth },
      defaults: withTenant({ referenceMonth, status: 'OPEN', createdBy: tenant.userId, updatedBy: tenant.userId }),
      transaction: t,
    })
  );
  const before = await withCommitted((t) => PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth }, transaction: t }));
  assert.equal(before.status, 'OPEN');

  await withRollbackTenantTransaction(tenant, async (t1) => {
    await confirmChecks(referenceMonth, tenant.userId, t1);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, t1);
    await withRollbackTenantTransaction(tenant, async (t2) => {
      await sequelize.query("SET LOCAL lock_timeout = '1500ms'", { transaction: t2 });
      await assert.rejects(
        periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverA.id, t2),
        (err) => {
          const pgCode = (err.original && err.original.code) || (err.parent && err.parent.code);
          assert.equal(pgCode, '55P03', `esperado lock_not_available, veio ${pgCode || err.code}: ${err.message}`);
          return true;
        }
      );
    }, 0);
  });

  const after = await withCommitted((t) => PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth }, transaction: t }));
  assert.equal(after.status, 'OPEN', 'nada foi commitado');
});

// =============================================================================================
// Item 2 via HTTP + item 7 (nenhum fechamento/pedido commitado)
// =============================================================================================

test('F02-C7 (HTTP): devolver para aberto exige finance:approve, MFA e motivo; o checklist mostra pagamentos em trânsito', async () => {
  const referenceMonth = COMMITTED_HTTP_MONTH;
  const requesterToken = tokenFor(tenant.userId, ['finance:read', 'finance:settle']);
  const approverToken = tokenFor(mfaApprover.id, ['finance:read', 'finance:approve']);
  const before = await withCommitted((t) => PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth }, transaction: t }));

  const pre = await http('GET', `/finance/period-closures/${referenceMonth}/preconditions`, requesterToken);
  assert.equal(pre.status, 200);
  assert.deepEqual(pre.body.data.preconditions.items.map((item) => item.code), [
    'BANK_STATEMENTS_IMPORTED',
    'RECONCILIATION_PENDINGS',
    'CLASSIFICATION_PENDINGS',
    'PAYMENTS_IN_TRANSIT',
    'THIRD_PARTY_CASH_CHECKED',
    'COMMISSIONS_REPASSES_REVIEWED',
  ]);

  const forbidden = await http('POST', '/finance/period-closures/return-to-open', requesterToken, { referenceMonth, reason: 'x' });
  assert.equal(forbidden.status, 403);
  const noReason = await http('POST', '/finance/period-closures/return-to-open', approverToken, { referenceMonth });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'FINANCE_PERIOD_RETURN_REASON_REQUIRED');
  // Mês fora de REVIEW: a rota chega ao serviço (permissão + MFA ok) e recusa sem gravar nada.
  const notInReview = await http('POST', '/finance/period-closures/return-to-open', approverToken, { referenceMonth, reason: 'Teste HTTP' });
  assert.ok([404, 409].includes(notInReview.status), JSON.stringify(notInReview.body));
  assert.ok(['FINANCE_PERIOD_NOT_IN_REVIEW', 'FINANCE_PERIOD_NOT_FOUND'].includes(notInReview.body.error.code));

  const after = await withCommitted((t) => PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth }, transaction: t }));
  assert.equal(after ? after.status : null, before ? before.status : null, 'nada foi commitado');
  assert.equal(after ? String(after.updatedAt) : null, before ? String(before.updatedAt) : null);
});
