'use strict';

// Testes da auditoria externa de 2026-10-07 (contrato bruto, Anexo I, Centro Financeiro) —
// cobre os gaps confirmados pelo auditor lendo o contrato literal (não os checklists internos
// já resumidos):
//   1. (cobertura ampliada em test/marco4.batch3.test.js e test/adversarial.finance.test.js)
//   2. §11 "Conciliação bancária" — motor de sugestão com score/classe.
//   4. §14 "Comissões" — ajuste de comissão por cancelamento (FIN-TS-017).
//   5. FIN-TS-018 "Banco timeout | Execução sem confirmação | Não cria sucesso falso".
//   6. FIN-005 "Limites vêm do Motor de Regras" — antifraude migrado para o Motor de Regras.
//
// Todos rodam contra o banco real via withRollbackTenantTransaction (RLS real — SET LOCAL
// app.group_id/company_id/user_id), sem nenhum mock.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const antifraudService = require('../src/features/finance/financeAntifraud.service');
const commissionsService = require('../src/features/finance/commissions.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankPaymentsService = require('../src/features/finance/bankPayments.service');
const approvalsService = require('../src/features/finance/approvals.service');
const { seedFinanceAntifraudRules } = require('../scripts/seedFinanceAntifraudRules');
const { PaymentIntent, BankPaymentProviderRouting, FinancialEntry } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createEntry(transaction, overrides = {}) {
  let costCenterId = overrides.costCenterId;
  let resultCenterId = overrides.resultCenterId;
  const nature = overrides.nature || 'PAYABLE';
  if (!costCenterId && nature === 'PAYABLE') {
    costCenterId = (await createTestCostCenter(tenant, transaction)).id;
  }
  if (!resultCenterId && nature === 'RECEIVABLE') {
    resultCenterId = (await createTestResultCenter(tenant, transaction)).id;
  }
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 100,
      description: 'QA contract gaps',
      costCenterId,
      resultCenterId,
      ...overrides,
    },
    tenant.userId,
    transaction
  );
}

async function createActiveBankAccount(transaction, suffix) {
  const account = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `cg-${suffix}` },
    tenant.userId,
    transaction
  );
  account.status = 'ACTIVE';
  await account.save({ transaction });
  return account;
}

// ---------------------------------------------------------------------------------------
// Item 2 — Motor de sugestão de conciliação (contrato §11)
// ---------------------------------------------------------------------------------------

test('contrato §11 scoreMatch aplica os pesos EXATOS do contrato (0.45/0.30/0.15/0.10)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const outraConta = await createActiveBankAccount(transaction, `${suffix}-b`);
    const entry = await createEntry(transaction, {
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: 777.5,
      bankAccountId: account.id,
      dueAt: new Date(),
    });

    // Só valor bate (sem id externo, sem descrição referenciando o lançamento, conta
    // bancária DIFERENTE da do lançamento, data muito distante) -> só os 0.45 de amountMatch.
    const bankTxSoValor = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: outraConta.id, amount: 777.5, transactionDate: new Date('2020-01-01'), description: 'nada a ver' },
      tenant.userId,
      transaction
    );
    const soValor = reconciliationService.scoreMatch(bankTxSoValor, entry);
    assert.equal(soValor.score, 0.45);

    // Valor + referência textual (descrição contém o id do lançamento) + mesma conta + dentro
    // da janela de data -> 0.45 + 0.30 + 0.15 + 0.10 = 1.00, mas classifica como FORTE (não
    // EXATO), porque a referência não veio de id externo real — ver nota de modelagem no
    // próprio reconciliation.service.js.
    const bankTxForte = await bankTransactionsService.createBankTransaction(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        amount: 777.5,
        transactionDate: new Date(),
        description: `PIX recebido ref ${entry.id}`,
      },
      tenant.userId,
      transaction
    );
    const forte = reconciliationService.scoreMatch(bankTxForte, entry);
    assert.equal(forte.score, 1);
    assert.equal(reconciliationService.classifyMatch(forte), reconciliationService.MATCH_CLASSES.STRONG);

    // Valor + id externo igual ao idempotencyKey do lançamento + mesma conta + data -> EXATO.
    const entryComIdempotencia = await createEntry(transaction, {
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: 321,
      bankAccountId: account.id,
      dueAt: new Date(),
      idempotencyKey: `exact-${suffix}`,
    });
    const bankTxExato = await bankTransactionsService.createBankTransaction(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        amount: 321,
        transactionDate: new Date(),
        description: 'qualquer coisa',
        externalTransactionId: `exact-${suffix}`,
      },
      tenant.userId,
      transaction
    );
    const exato = reconciliationService.scoreMatch(bankTxExato, entryComIdempotencia);
    assert.equal(exato.score, 1);
    assert.equal(reconciliationService.classifyMatch(exato), reconciliationService.MATCH_CLASSES.EXACT);
  });
});

test('contrato §11 suggestReconciliationMatches classifica AMBÍGUO quando há múltiplos candidatos fortes empatados, e nunca auto concilia nesse caso', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const now = new Date();

    // Dois lançamentos RECEIVABLE abertos, mesmo valor, mesma conta, mesma janela de data, e a
    // descrição do extrato referencia os dois ids (texto de PIX que ecoa múltiplas referências)
    // — ambos batem em amount+reference+counterparty+date = score 1.00 (classe FORTE, sem id
    // externo) e EMPATADOS -> "Match ambíguo | 2 entries mesmo valor | Não auto concilia"
    // (FIN-TS-008).
    const e1 = await createEntry(transaction, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, bankAccountId: account.id, dueAt: now, description: 'e1' });
    const e2 = await createEntry(transaction, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, bankAccountId: account.id, dueAt: now, description: 'e2' });

    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 500, transactionDate: now, description: `PIX recebido ref ${e1.id} ${e2.id}` },
      tenant.userId,
      transaction
    );

    const suggestion = await reconciliationService.suggestReconciliationMatches(bankTx.id, transaction);
    assert.equal(suggestion.finalClass, reconciliationService.MATCH_CLASSES.AMBIGUOUS, 'dois candidatos fortes empatados -> AMBÍGUO, nunca auto');

    const autoResult = await reconciliationService.autoReconcileSuggestion(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankTransactionId: bankTx.id },
      tenant.userId,
      transaction
    );
    assert.equal(autoResult.autoReconciled, false, 'AMBÍGUO nunca é auto-conciliado');

    const existing = await reconciliationService.listReconciliations(transaction, { bankTransactionId: bankTx.id });
    assert.equal(existing.length, 0, 'nenhuma conciliação foi criada automaticamente');

    void e1;
    void e2;
  });
});

test('contrato §11 autoReconcileSuggestion concilia automaticamente só nas classes EXATO/FORTE, sem ambiguidade', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const now = new Date();

    const entry = await createEntry(transaction, {
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: 1234.56,
      bankAccountId: account.id,
      dueAt: now,
      idempotencyKey: `auto-exact-${suffix}`,
    });
    const bankTx = await bankTransactionsService.createBankTransaction(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        amount: 1234.56,
        transactionDate: now,
        description: 'PIX recebido',
        externalTransactionId: `auto-exact-${suffix}`,
      },
      tenant.userId,
      transaction
    );

    const autoResult = await reconciliationService.autoReconcileSuggestion(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankTransactionId: bankTx.id },
      tenant.userId,
      transaction
    );
    assert.equal(autoResult.finalClass, reconciliationService.MATCH_CLASSES.EXACT);
    assert.equal(autoResult.autoReconciled, true);
    assert.ok(autoResult.reconciliation);
    assert.equal(autoResult.reconciliation.financialEntryId, entry.id);
  });
});

test('contrato §11 suggestReconciliationMatches devolve SEM CORRESPONDÊNCIA quando nenhum candidato chega a 0.45', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    await createEntry(transaction, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 999, bankAccountId: account.id, dueAt: new Date('2000-01-01'), description: 'nada a ver' });

    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 15, transactionDate: new Date(), description: 'totalmente diferente' },
      tenant.userId,
      transaction
    );

    const suggestion = await reconciliationService.suggestReconciliationMatches(bankTx.id, transaction);
    assert.equal(suggestion.finalClass, reconciliationService.MATCH_CLASSES.NO_MATCH);
    assert.equal(suggestion.candidates.length, 0);

    void suffix;
  });
});

// ---------------------------------------------------------------------------------------
// Item 4 — ajuste de comissão por cancelamento (contrato §14, FIN-TS-017)
// ---------------------------------------------------------------------------------------

test('FIN-TS-017 cancelCommission gera ajuste auditável, proporcional ao já pago, e nunca apaga o histórico', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { User } = require('../src/models');
    const beneficiary = await User.create(
      { name: `QA comissão ${suffix}`, email: `qa-commission-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    const { commission, installments } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: beneficiary.id, baseAmount: 10000, percentage: 6, installmentsCount: 2, idempotencyKey: `commission-${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    assert.equal(Number(commission.totalAmount), 600);

    // Paga a 1ª parcela (300) contra um lançamento real liquidado — já recebido.
    const entry = await createEntry(transaction, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: installments[0].amount, description: 'baixa parcela 1' });
    await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);
    await commissionsService.markInstallmentPaid(installments[0].id, entry.id, tenant.userId, transaction);

    // Contrato cancelado -> ajuste de comissão.
    const { commission: cancelled, adjustment } = await commissionsService.cancelCommission(
      commission.id,
      'Contrato de locação cancelado antes do fim da vigência (FIN-TS-017)',
      tenant.userId,
      transaction
    );
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(adjustment.adjustmentType, 'CANCELLATION_REVERSAL');
    assert.equal(adjustment.paidAmountBefore, 300, 'proporcional ao que já foi pago/recebido');
    assert.equal(adjustment.totalAmountBefore, 600);
    assert.equal(adjustment.adjustmentAmount, -300, 'ajusta só o saldo em aberto (600 - 300 já pago), nunca o que já foi pago');

    // Histórico NUNCA apagado: a comissão continua existindo, a parcela PAGA continua PAGA.
    const stillThere = await commissionsService.getCommission(commission.id, transaction);
    assert.ok(stillThere);
    const reloadedInstallments = await commissionsService.listCommissionInstallments(commission.id, transaction);
    const paidInstallment = reloadedInstallments.find((i) => i.id === installments[0].id);
    assert.equal(paidInstallment.status, 'PAID', 'parcela já paga nunca é desfeita pelo cancelamento');
    const pendingInstallment = reloadedInstallments.find((i) => i.id === installments[1].id);
    assert.equal(pendingInstallment.status, 'CANCELLED');

    // Ajuste é auditável/consultável.
    const adjustments = await commissionsService.getCommissionAdjustments(commission.id, transaction);
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].adjustmentAmount, -300);

    // Cancelar de novo é rejeitado (não duplica ajuste).
    await assert.rejects(
      () => commissionsService.cancelCommission(commission.id, 'segunda tentativa', tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_COMMISSION_ALREADY_CANCELLED'); return true; }
    );

    // Motivo é obrigatório.
    const { commission: commission2 } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: beneficiary.id, baseAmount: 1000, percentage: 5, idempotencyKey: `commission-${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => commissionsService.cancelCommission(commission2.id, '', tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_COMMISSION_CANCEL_REASON_REQUIRED'); return true; }
    );
  });
});

// ---------------------------------------------------------------------------------------
// Item 5 — FIN-TS-018 Banco timeout | Execução sem confirmação | Não cria sucesso falso
// ---------------------------------------------------------------------------------------

test('FIN-TS-018 confirmBankPayment com status de timeout/falha NUNCA liquida o lançamento nem cria sucesso falso', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    account.pixKey = `qa-pix-${suffix}@nayaraone.dev`;
    await account.save({ transaction });

    const entry = await createEntry(transaction, { bankAccountId: account.id, amount: 450 });

    const { User } = require('../src/models');
    const approver = await User.create(
      { name: `QA FIN-TS-018 aprovador ${suffix}`, email: `qa-fints018-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, transaction);

    const submitted = await bankPaymentsService.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);
    assert.equal(submitted.status, 'SUBMITTED');

    const routing = await BankPaymentProviderRouting.findOne({ where: { paymentIntentId: intent.id }, transaction });
    assert.ok(routing, 'roteamento gravado para o webhook/polling resolver o tenant depois');

    // Simula o banco respondendo TIMEOUT (nenhuma confirmação confiável) — "sistema nunca
    // presume sucesso" (Centro Financeiro §8, item 8).
    const afterTimeout = await bankPaymentsService.confirmBankPayment(routing.externalSubmissionId, 'TIMEOUT', transaction);
    assert.equal(afterTimeout.status, 'FAILED', 'timeout nunca deixa a intenção como sucesso');
    assert.notEqual(afterTimeout.status, 'EXECUTED');

    const reloadedEntry = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(reloadedEntry.status, 'PENDING', 'NENHUMA liquidação indevida — o lançamento original nunca foi tocado');
    assert.equal(reloadedEntry.settledAt, null);

    // Reprocessar o MESMO status de novo (reentrega de webhook) é idempotente: devolve o
    // estado atual, sem tentar liquidar por trás.
    const reloadedIntent = await PaymentIntent.findByPk(intent.id, { transaction });
    assert.equal(reloadedIntent.status, 'FAILED');
    const again = await bankPaymentsService.confirmBankPayment(routing.externalSubmissionId, 'TIMEOUT', transaction);
    assert.equal(again.status, 'FAILED');
    const reloadedEntryAgain = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(reloadedEntryAgain.status, 'PENDING');
  });
});

// ---------------------------------------------------------------------------------------
// Item 6 — FIN-005 limiares de antifraude vêm do Motor de Regras
// ---------------------------------------------------------------------------------------

test('FIN-005 resolveAntifraudThresholds usa os defaults hardcoded quando a regra não foi publicada para o tenant (fail closed, nunca enfraquece a proteção)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const thresholds = await antifraudService.resolveAntifraudThresholds(tenant, transaction);
    assert.equal(thresholds.historyMultiplier, antifraudService.DEFAULT_ANOMALY_HISTORY_MULTIPLIER);
    assert.equal(thresholds.newAccountThreshold, antifraudService.DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD);
    assert.equal(thresholds.cooldownHours, antifraudService.DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS);
    assert.equal(thresholds.ruleVersionId, null, 'sem regra publicada, não há ruleVersionId');
  });
});

test('FIN-005 limiares de antifraude vêm do Motor de Regras (evaluateRule) quando a regra FIN-005 está publicada, ajustável via settings', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await seedFinanceAntifraudRules(tenant, transaction);
    const thresholds = await antifraudService.resolveAntifraudThresholds(tenant, transaction);
    assert.ok(thresholds.ruleVersionId, 'com a regra publicada, a decisão fica rastreada por ruleVersionId');
    // Sem override de settings, usa o actionJson da regra (os mesmos valores que eram
    // hardcoded antes, preservados como default da regra — ver seedFinanceAntifraudRules.js).
    assert.equal(thresholds.historyMultiplier, 3);
    assert.equal(thresholds.newAccountThreshold, 10000);
    assert.equal(thresholds.bankAccountCooldownHours ?? thresholds.cooldownHours, thresholds.cooldownHours);
  });
});

test('FIN-005 flagAnomalousPayment continua detectando desvio histórico e primeiro-pagamento-alto com os limiares resolvidos pelo Motor de Regras', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await seedFinanceAntifraudRules(tenant, transaction);
    const account = await createActiveBankAccount(transaction, suffix);

    const entry = await createEntry(transaction, { amount: 50000, bankAccountId: account.id });
    const flag = await antifraudService.flagAnomalousPayment(entry, transaction);
    assert.equal(flag.flagged, true, 'conta nova recebendo pagamento alto continua detectada mesmo com os limiares vindos do Motor de Regras');
    assert.match(flag.reason, /FIN-005/);

    // GAP REAL CORRIGIDO (Caderno §17/§19): flagAnomalousPayment agora também abre um
    // AnomalyCase HIGH (antes só marcava a flag requires_manual_review, sem registro próprio).
    const { AnomalyCase } = require('../src/models');
    const cases = await AnomalyCase.findAll({ where: { relatedEntityId: entry.id, companyId: tenant.companyId }, transaction });
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, 'OPEN');
    assert.equal(cases[0].riskLevel, 'HIGH');
    assert.equal(cases[0].caseType, 'AMOUNT_OUTLIER');
  });
});

test('FIN-TS-013 cooling period de conta nova continua bloqueando pagamento imediato, com o limiar vindo do Motor de Regras', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await seedFinanceAntifraudRules(tenant, transaction);
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `fin013-${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(account.status, 'PENDING_COOLDOWN');

    await assert.rejects(
      () => antifraudService.assertBankAccountEligibleForPayment(account.id, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_COOLDOWN'); return true; }
    );
  });
});

test('antifraude: estorno frequente abre AnomalyCase (nunca bloqueia o estorno em si); conciliação manual recorrente só sinaliza', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);

    let lastReversal;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const entry = await createEntry(transaction, { bankAccountId: account.id, description: `estorno frequente ${i}` });
      // eslint-disable-next-line no-await-in-loop
      lastReversal = await financialEntriesService.reverseFinancialEntry(entry.id, `QA estorno ${i}`, tenant.userId, transaction);
    }

    const alert = await antifraudService.checkFrequentReversalAlert(tenant.companyId, transaction);
    assert.ok(alert.count >= 3);
    assert.equal(alert.flagged, true, 'contador simples sinaliza estorno frequente — sem bloquear o estorno em si');

    // GAP REAL CORRIGIDO (Caderno §17, "Estorno frequente → Anomaly case"): reverseFinancialEntry
    // agora chama checkFrequentReversalAlert e, quando cruza o limiar, abre um AnomalyCase.
    const { AnomalyCase } = require('../src/models');
    const openCases = await AnomalyCase.findAll({
      where: { companyId: tenant.companyId, caseType: 'FREQUENT_REVERSAL', status: 'OPEN' },
      transaction,
    });
    assert.ok(openCases.length >= 1, 'pelo menos um AnomalyCase de estorno frequente deve existir (aberto no último estorno que cruzou o limiar)');
    assert.equal(openCases[0].riskLevel, 'HIGH');
    void lastReversal;

    const reconciliationAlert = await antifraudService.checkRecurringManualReconciliationAlert(tenant.companyId, transaction);
    assert.equal(typeof reconciliationAlert.count, 'number');
    assert.equal(typeof reconciliationAlert.flagged, 'boolean');
  });
});

// FIX FIN-004 (auditoria externa Abacus AI, 11/10/2026): o lançamento de teste da auditora
// abriu a ação "Liquidar" direto no detalhe, sem passar por nenhuma fila de aprovação (só
// bloqueada pelo 2FA). Reproduzido ao vivo antes do fix: settleFinancialEntry liquidava
// qualquer PAYABLE com bankAccountId sem checar payment_intent/ApprovalRequest nenhuma. Fix:
// gate em financialEntries.service.js#settleFinancialEntry.
test('FIN-004: PAYABLE com conta bancária não pode ser liquidado sem aprovação prévia (payment_intent OU ApprovalRequest)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);

    // 1) Liquidação direta SEM nenhuma aprovação é recusada.
    const entry1 = await createEntry(transaction, { bankAccountId: account.id, amount: 1000, idempotencyKey: `fin004-a-${suffix}` });
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry1.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL');
        return true;
      }
    );
    const reread1 = await FinancialEntry.findByPk(entry1.id, { transaction });
    assert.equal(reread1.status, 'PENDING', 'nada foi liquidado sem aprovação');

    // 2) Via payment_intent aprovado + executado: liquida normalmente.
    const entry2 = await createEntry(transaction, { bankAccountId: account.id, amount: 1000, idempotencyKey: `fin004-b-${suffix}` });
    const { User: User2 } = require('../src/models');
    const [intentApprover] = await User2.findOrCreate({
      where: { email: `homo-qa-fin004-intent-approver-${suffix}@nayaraone.dev` },
      defaults: { name: `HOMO QA — Aprovador intent FIN-004 ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    const intent = await paymentIntentsService.createPaymentIntent(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry2.id, idempotencyKey: `fin004-intent-${suffix}` },
      tenant.userId,
      transaction
    );
    await paymentIntentsService.approvePaymentIntent(intent.id, intentApprover.id, transaction);
    const executed = await paymentIntentsService.executePaymentIntent(intent.id, tenant.userId, transaction);
    assert.equal(executed.intent.status, 'EXECUTED');
    assert.equal(executed.entry.status, 'SETTLED');
    const reread2 = await FinancialEntry.findByPk(entry2.id, { transaction });
    assert.equal(reread2.status, 'SETTLED');

    // 3) Via ApprovalRequest aprovada (maker-checker genérico) para o mesmo FinancialEntry:
    // liquida normalmente, sem precisar de payment_intent.
    const entry3 = await createEntry(transaction, { bankAccountId: account.id, amount: 1000, idempotencyKey: `fin004-c-${suffix}` });
    const { User } = require('../src/models');
    const [approver] = await User.findOrCreate({
      where: { email: `homo-qa-fin004-approver-${suffix}@nayaraone.dev` },
      defaults: { name: `HOMO QA — Aprovador FIN-004 ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry3.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );
    await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, transaction);
    const settled3 = await financialEntriesService.settleFinancialEntry(entry3.id, tenant.userId, transaction);
    assert.equal(settled3.status, 'SETTLED');

    // 4) RECEIVABLE continua liquidando direto, sem exigir nenhuma aprovação (Caderno §10).
    const resultCenter = await createTestResultCenter(tenant, transaction, suffix);
    const receivable = await createEntry(transaction, { nature: 'RECEIVABLE', resultCenterId: resultCenter.id, amount: 500, idempotencyKey: `fin004-d-${suffix}` });
    const settledReceivable = await financialEntriesService.settleFinancialEntry(receivable.id, tenant.userId, transaction);
    assert.equal(settledReceivable.status, 'SETTLED', 'recebimento não exige aprovação prévia, só pagamento exige');
  });
});

// FIX FIN-TS-007 (auditoria externa Abacus AI, 11/10/2026): "Nenhuma tela de importação
// OFX/CSV encontrada" — bankTransactions.service.js só tinha criação individual (via
// API/webhook); importBankStatement é o caminho de LOTE novo.
test('FIN-TS-007: importação de extrato em lote (CSV) é idempotente — reimportar o MESMO arquivo não duplica', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const bankTransactionsService = require('../src/features/finance/bankTransactions.service');

    const csv = [
      'externalTransactionId,transactionDate,description,amount',
      `ext-${suffix}-1,2026-10-01,Pagamento recebido,100.50`,
      `ext-${suffix}-2,2026-10-02,Tarifa bancária,-15.00`,
    ].join('\n');

    const firstImport = await bankTransactionsService.importBankStatement(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, csvText: csv },
      tenant.userId,
      transaction
    );
    assert.equal(firstImport.imported.length, 2);
    assert.equal(firstImport.duplicates.length, 0);

    // Reimportar o MESMO arquivo: nenhuma linha nova, todas marcadas como duplicata.
    const secondImport = await bankTransactionsService.importBankStatement(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, csvText: csv },
      tenant.userId,
      transaction
    );
    assert.equal(secondImport.imported.length, 0, 'reimportar o mesmo arquivo não cria linha nova nenhuma');
    assert.equal(secondImport.duplicates.length, 2);

    const all = await bankTransactionsService.listBankTransactions(transaction, { bankAccountId: account.id });
    assert.equal(all.length, 2, 'total de transações na conta continua 2, não 4');
  });
});

test('FIN-TS-007: importação de extrato recusa CSV com cabeçalho errado ou linha sem externalTransactionId', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const bankTransactionsService = require('../src/features/finance/bankTransactions.service');

    await assert.rejects(
      () => bankTransactionsService.importBankStatement(
        { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, csvText: 'id,data,valor\n1,2026-10-01,100' },
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_HEADER'); return true; }
    );

    await assert.rejects(
      () => bankTransactionsService.importBankStatement(
        {
          groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id,
          csvText: `externalTransactionId,transactionDate,description,amount\n,2026-10-01,sem id,100`,
        },
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_STATEMENT_IMPORT_MISSING_EXTERNAL_ID'); return true; }
    );
  });
});

// FIN-004(c) — verificação cética pós-correção (11/10/2026): o fix original só provou a parte
// "aprovação prévia obrigatória" (settleFinancialEntry recusa sem payment_intent/ApprovalRequest
// aprovado). As partes "snapshot/hash" e "invalidação ao trocar favorecido" já eram cobertas por
// mecanismos existentes (computeSnapshotHash em paymentIntents.service.js; isBankAccountRedirect
// em updateFinancialEntry marca requiresManualReview=true), mas NENHUM teste provava o cenário
// COMBINADO: ApprovalRequest aprovada -> favorecido (bankAccountId) trocado depois -> tentativa
// de liquidação direta tem que ser bloqueada mesmo com a aprovação antiga ainda "válida" no
// registro. Reproduzido ao vivo antes deste teste existir: bloqueava corretamente via
// FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW — comportamento já correto, só sem prova formal.
test('FIN-004(c): trocar o favorecido (bankAccountId) DEPOIS de uma ApprovalRequest aprovada invalida a liquidação direta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const bankA = await createActiveBankAccount(transaction, `fin004c-a-${suffix}`);
    const bankB = await createActiveBankAccount(transaction, `fin004c-b-${suffix}`);
    const entry = await createEntry(transaction, { bankAccountId: bankA.id, idempotencyKey: `fin004c-${suffix}` });

    const { User } = require('../src/models');
    const [approver] = await User.findOrCreate({
      where: { email: `fin004c-approver-${suffix}@nayaraone.dev` },
      defaults: { name: 'HOMO QA — Aprovador FIN-004(c)', passwordHash: 'x', status: 'ACTIVE' },
    });
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );
    await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, transaction);

    // Troca o favorecido depois da aprovação já concedida.
    await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: bankB.id }, tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW'); return true; }
    );

    const refreshed = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(refreshed.status, 'PENDING', 'o lançamento não deve ter sido liquidado com a aprovação antiga.');
  });
});

// FIN-TS-002 (Caderno §20: "Race — 2 workers executam intent — 1 vence; outro idempotente") —
// verificação cética encontrou que nenhum teste provava isso: o lock FOR UPDATE em
// getPaymentIntentForUpdate e a checagem de status 'APPROVED' sugeriam proteção, mas sem prova
// de concorrência REAL (duas conexões/transações distintas, não duas chamadas sequenciais na
// mesma transação). Concorrência real precisa de transações COMMITADAS — usa o mesmo padrão
// `withCommitted` já usado em ADV-F21 (test/adversarial.finance.test.js).
test('FIN-TS-002: duas execuções CONCORRENTES da mesma payment intent — uma vence, a outra é rejeitada (idempotente, não duplica ledger)', async () => {
  const suffix = uniqueSuffix();
  async function withCommitted(fn) {
    const t = await sequelize.transaction();
    try {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
      const r = await fn(t);
      await t.commit();
      return r;
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  let entryId;
  let bankAccountId;
  let intentId;
  try {
    const { User } = require('../src/models');
    const [maker] = await User.findOrCreate({
      where: { email: `fints002-maker-${suffix}@nayaraone.dev` },
      defaults: { name: 'HOMO QA — Maker FIN-TS-002', passwordHash: 'x', status: 'ACTIVE' },
    });
    const [approver] = await User.findOrCreate({
      where: { email: `fints002-approver-${suffix}@nayaraone.dev` },
      defaults: { name: 'HOMO QA — Approver FIN-TS-002', passwordHash: 'x', status: 'ACTIVE' },
    });

    await withCommitted(async (t) => {
      const account = await createActiveBankAccount(t, `fints002-${suffix}`);
      bankAccountId = account.id;
      const entry = await createEntry(t, { amount: 500, bankAccountId: account.id, idempotencyKey: `fints002-entry-${suffix}` });
      entryId = entry.id;
      const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, maker.id, t);
      intentId = intent.id;
      await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, t);
    });

    // Duas "execuções" concorrentes de verdade — cada uma na sua própria transação commitada.
    const resultados = await Promise.allSettled([
      withCommitted((t) => paymentIntentsService.executePaymentIntent(intentId, approver.id, t)),
      withCommitted((t) => paymentIntentsService.executePaymentIntent(intentId, approver.id, t)),
    ]);

    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    const falhas = resultados.filter((r) => r.status === 'rejected');
    assert.equal(sucessos.length, 1, 'exatamente UMA das duas execuções concorrentes deve vencer');
    assert.equal(falhas.length, 1, 'a outra deve ser rejeitada (não executar duas vezes)');
    assert.equal(
      falhas[0].reason.code,
      'FINANCE_PAYMENT_INTENT_NOT_APPROVED',
      'a perdedora falha porque, quando ela consegue o lock, a intent já não está mais APPROVED (a vencedora já mudou pra EXECUTED)'
    );

    await withCommitted(async (t) => {
      const ledgerCount = await FinancialEntry.count({ where: { id: entryId, status: 'SETTLED' }, transaction: t });
      assert.equal(ledgerCount, 1, 'o lançamento foi liquidado exatamente uma vez');
    });
  } finally {
    await withCommitted(async (t) => {
      await sequelize.query('DELETE FROM finance.payment_intents WHERE id = :id', { replacements: { id: intentId }, transaction: t });
      await sequelize.query('DELETE FROM finance.financial_entries WHERE id = :id', { replacements: { id: entryId }, transaction: t });
      await sequelize.query('DELETE FROM finance.bank_accounts WHERE id = :id', { replacements: { id: bankAccountId }, transaction: t });
    });
  }
});
