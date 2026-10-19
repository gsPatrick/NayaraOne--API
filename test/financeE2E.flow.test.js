'use strict';

/**
 * Teste de ponta a ponta do Financeiro (conferência M45): UM fluxo só, do lançamento ao relatório,
 * contra o Postgres de homologação pelo usuário de runtime (RLS FORCE), dentro de UMA transação
 * que sempre faz rollback — nada fica gravado (o ledger é append-only, então nada pode "sobrar").
 *
 *   lançamento (PAYABLE)
 *     -> intenção de pagamento (criada por um, aprovada por OUTRO)
 *     -> envio ao banco SANDBOX (intenção SUBMITTED, lançamento ainda PENDING)
 *     -> callback do banco com HMAC: forjado é recusado; válido confirma; replay não duplica
 *     -> ledger: lançamento SETTLED / SANDBOX_CONFIRMED, linha auditada pelo trigger do banco
 *     -> extrato: importação CSV da saída correspondente (reimportar não duplica)
 *     -> conciliação: lançamento x linha do extrato (valor no centavo; segunda vez é recusada)
 *     -> relatório: saúde financeira semanal tira o valor de "a pagar"; conciliação listada
 *
 * O callback passa pelo MESMO código do webhook público (finance.controller
 * processBankPaymentWebhook: roteamento -> SET LOCAL -> HMAC -> confirmBankPayment) — só a
 * transação vem de fora, para permitir o rollback.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankPaymentsService = require('../src/features/finance/bankPayments.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const healthReportService = require('../src/features/finance/financialHealthReport.service');
const settingsService = require('../src/features/settings/settings.service');
const financeController = require('../src/features/finance/finance.controller');
const { setBankAdapterOverrideForTests } = require('../src/features/finance/adapters/resolveBankAdapter');
const { BankAccount, FinancialEntry, PaymentIntent, User, AuditLog } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
  setBankAdapterOverrideForTests(null);
});
after(async () => {
  await sequelize.close();
});

function todayBR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

test('Financeiro E2E: lançamento -> intenção -> callback sandbox HMAC -> ledger -> extrato -> conciliação -> relatório', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const W = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

    // Provedor sandbox com segredo de webhook PRÓPRIO deste teste (some no rollback).
    const webhookSecret = crypto.randomBytes(24).toString('hex');
    await settingsService.upsertSetting('finance.payment_provider', 'sandbox', tenant, tenant.userId, t);
    await settingsService.upsertSetting('finance.bank_payment_webhook_secret', webhookSecret, tenant, tenant.userId, t);

    // 1) Lançamento a pagar.
    const amount = Number((1000 + Math.floor(Math.random() * 9000) + Math.floor(Math.random() * 100) / 100).toFixed(2));
    const bank = await BankAccount.create(W({ bankCode: '001', agency: '0001', accountNumber: `E2E-${suffix}`, pixKey: `e2e-${suffix}@nayaraone.dev`, status: 'ACTIVE' }), { transaction: t });
    const cc = await createTestCostCenter(tenant, t);
    const entry = await financialEntriesService.createFinancialEntry(
      W({ entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `E2E Financeiro ${suffix}`, costCenterId: cc.id, bankAccountId: bank.id, dueAt: new Date(Date.now() + 2 * 86400000) }),
      tenant.userId, t
    );
    assert.equal(entry.status, 'PENDING');
    const reportBefore = await healthReportService.getWeeklyHealthReport(t, { companyId: tenant.companyId });

    // 2) Intenção: criada por um, aprovada por outro.
    const approver = await User.create({ email: `e2e-fin-approver-${suffix}@nayaraone.dev`, name: 'E2E aprovador', passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await assert.rejects(paymentIntentsService.approvePaymentIntent(intent.id, tenant.userId, t));
    await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, t);

    // 3) Envio ao banco sandbox: SUBMITTED, lançamento continua PENDING (sem ledger antes da confirmação).
    const submitted = await bankPaymentsService.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, t);
    const sentIntent = await PaymentIntent.findByPk(intent.id, { transaction: t });
    assert.equal(sentIntent.status, 'SUBMITTED');
    const externalSubmissionId = sentIntent.externalSubmissionId || submitted.externalSubmissionId;
    assert.ok(externalSubmissionId, 'o sandbox devolve o id externo do pagamento');
    assert.equal((await FinancialEntry.findByPk(entry.id, { transaction: t })).status, 'PENDING');

    // 4) Callback do banco. Forjado: recusado, nada muda.
    const body = { externalSubmissionId, status: 'CONFIRMED' };
    const rawBody = Buffer.from(JSON.stringify(body));
    await assert.rejects(
      financeController.processBankPaymentWebhook({ body, rawBody, headers: { 'x-webhook-signature': `sha256=${'0'.repeat(64)}` } }, t),
      (err) => err.code === 'BANK_PAYMENT_WEBHOOK_HMAC_INVALID'
    );
    assert.equal((await FinancialEntry.findByPk(entry.id, { transaction: t })).status, 'PENDING');
    // Válido: confirma.
    const signature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
    const processed = await financeController.processBankPaymentWebhook({ body, rawBody, headers: { 'x-webhook-signature': signature } }, t);
    assert.deepEqual(processed, { received: true, processed: true });

    // 5) Ledger.
    const settled = await FinancialEntry.findByPk(entry.id, { transaction: t });
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.settlementMethod, 'SANDBOX_CONFIRMED');
    assert.ok(settled.settledAt);
    assert.equal(Number(settled.amount), amount);
    assert.equal((await PaymentIntent.findByPk(intent.id, { transaction: t })).status, 'EXECUTED');
    const rowAudit = await AuditLog.findOne({ where: { entityId: entry.id, action: 'finance.financial_entry.row_change' }, transaction: t });
    assert.ok(rowAudit, 'a mudança de status no ledger foi registrada pelo trigger do banco');
    // Replay do mesmo callback: nada novo (nenhum filho, mesma versão).
    const lockVersion = settled.lockVersion;
    const replay = await financeController.processBankPaymentWebhook({ body, rawBody, headers: { 'x-webhook-signature': signature } }, t);
    assert.equal(replay.processed, true);
    const afterReplay = await FinancialEntry.findByPk(entry.id, { transaction: t });
    assert.equal(afterReplay.lockVersion, lockVersion);
    assert.equal(await FinancialEntry.count({ where: { parentEntryId: entry.id }, transaction: t }), 0);

    // 6) Extrato: a saída aparece no extrato importado do banco (reimportar não duplica).
    const day = todayBR();
    const extId = `E2E-STMT-${suffix}`;
    const csvText = `externalTransactionId,transactionDate,description,amount\n${extId},${day},PIX enviado E2E ${suffix},${(-amount).toFixed(2)}\n`;
    const imported = await bankTransactionsService.importBankStatement(W({ bankAccountId: bank.id, csvText }), tenant.userId, t);
    assert.equal(imported.imported.length, 1);
    const reimported = await bankTransactionsService.importBankStatement(W({ bankAccountId: bank.id, csvText }), tenant.userId, t);
    assert.equal(reimported.imported.length, 0);
    assert.equal(reimported.duplicates.length, 1);
    const statementLines = await bankTransactionsService.listBankTransactions(t, { bankAccountId: bank.id });
    assert.equal(statementLines.length, 1);
    const bankTx = statementLines[0];
    assert.equal(Math.abs(Number(bankTx.amount)), amount);

    // 7) Conciliação no centavo; a segunda tentativa é recusada.
    const rec = await reconciliationService.matchReconciliation(W({ financialEntryId: entry.id, bankTransactionId: bankTx.id }), tenant.userId, t);
    assert.ok(rec.id);
    await assert.rejects(reconciliationService.matchReconciliation(W({ financialEntryId: entry.id, bankTransactionId: bankTx.id }), tenant.userId, t));

    // 8) Relatório: o valor saiu de "a pagar" e a conciliação aparece na listagem.
    const reportAfter = await healthReportService.getWeeklyHealthReport(t, { companyId: tenant.companyId });
    const cents = (v) => Math.round(Number(v) * 100);
    assert.equal(cents(reportBefore.payablePending.total) - cents(reportAfter.payablePending.total), cents(amount));
    assert.equal(reportBefore.payablePending.count - reportAfter.payablePending.count, 1);
    const recs = await reconciliationService.listReconciliations(t, {});
    const list = Array.isArray(recs) ? recs : recs.items || recs.rows || [];
    assert.ok(list.some((r) => (r.id || r.reconciliationId) === rec.id || r.financialEntryId === entry.id), 'conciliação listada');
  });
});
