'use strict';

// M4PG — Guia M4 §4 preparePayment (assertPayable, assertAmountWithinOpenBalance, rules.evaluate('REG-FIN-002') + approvals.createFromRule),
// §1.6 e Caderno §2 FIN-005 ("Limites vêm do Motor de Regras"), §8.1-8.3 e §8.5-8.6, §3 (estados), §5 (EXECUTING +
// finance.payment.execution_requested e replay pela chave), §8.12 (divergência abre anomaly_case) e FIN-TS-002.
// Sondas reproduzidas: V2-P3 (intenção de pagamento sobre recebível), V2-P2 e P9 (risco LOW escolhido pelo pedido para R$ 900 mil / 1 milhão).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter, createManualSettlementEvidence } = require('./testHelpers');
const { comMfaRecente, gravarParametro } = require('./helpers/mfaRecente');
const fe = require('../src/modules/finance/application/services/financial-entry.service');
const bankAccounts = require('../src/modules/finance/application/services/bank-accounts.service');
const payments = require('../src/modules/finance/application/services/payment.service');
const bankSubmission = require('../src/modules/finance/application/services/bank-submission.service');
const approvals = require('../src/modules/finance/application/services/approvals.service');
const settlementEvidence = require('../src/modules/finance/application/services/settlement-evidence.service');
const { User, PaymentIntent, ApprovalRequest, AnomalyCase, FinancialEntry, BankPaymentProviderRouting, OutboxEvent, AuditLog, Rule, RuleVersion, RuleScope, RulePublication } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const T = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const newUser = (t, label) => User.create({ name: `M4PG ${label}`, email: `m4pg-${label}-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });

async function agedAccount(t) {
  const s = uniqueSuffix();
  const acc = await bankAccounts.createBankAccount({ ...T(), bankCode: '001', agency: '0001', accountNumber: `PP-${s}`, pixKey: `pp-${s}@m4pg.dev` }, tenant.userId, t);
  await sequelize.query("UPDATE finance.bank_accounts SET status = 'ACTIVE', created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE id = :id", { replacements: { id: acc.id }, transaction: t });
  return acc;
}

async function payable(t, amount, extra = {}) {
  const cc = await createTestCostCenter(tenant, t);
  return fe.createFinancialEntry({ ...T(), entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `m4pg pagamento ${uniqueSuffix()}`, costCenterId: cc.id, ...extra }, tenant.userId, t);
}

async function submitAndConfirm(t, intentId, amount) {
  await bankSubmission.submitPaymentIntentToBank(intentId, 'PIX', { userId: tenant.userId }, t);
  const routing = await BankPaymentProviderRouting.findOne({ where: { paymentIntentId: intentId }, transaction: t });
  return payments.confirmBankPayment(routing.externalSubmissionId, 'CONFIRMED', t, { amount });
}

test('M4-G§4 assertPayable (V2-P3): intenção de PAGAMENTO sobre lançamento A RECEBER é recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await agedAccount(t);
    const rc = await createTestResultCenter(tenant, t);
    const receivable = await fe.createFinancialEntry({ ...T(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 700, description: 'm4pg recebível', resultCenterId: rc.id, bankAccountId: acc.id }, tenant.userId, t);
    await assert.rejects(() => payments.createPaymentIntent({ financialEntryId: receivable.id }, tenant.userId, t), (e) => e.code === 'FINANCE_PAYMENT_INTENT_NOT_PAYABLE');
    assert.equal(await PaymentIntent.count({ where: { financialEntryId: receivable.id }, transaction: t }), 0);
  });
});

test('M4-§8.1/§8.2/§8.3/G§4: PREPARE escolhe valor/parcela até o saldo; lançamento PARTIALLY_SETTLED é pagável pelo saldo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await agedAccount(t);
    const entry = await payable(t, 100, { bankAccountId: acc.id });
    const approver = await newUser(t, 'aprovador-parcela');

    const first = await payments.createPaymentIntent({ financialEntryId: entry.id, amount: '40.00' }, tenant.userId, t);
    assert.equal(first.status, 'PENDING_APPROVAL');
    assert.equal(first.snapshotJson.amount, '40.00');
    assert.equal(first.snapshotJson.entryAmount, '100.00');
    assert.equal(first.installmentNumber, 1);
    await payments.approvePaymentIntent(first.id, approver.id, t);
    const confirmed = await submitAndConfirm(t, first.id, '40.00');
    assert.equal(confirmed.status, 'CONFIRMED');
    const partial = await FinancialEntry.findByPk(entry.id, { transaction: t });
    assert.equal(partial.status, 'PARTIALLY_SETTLED', 'pagou só a parcela escolhida');

    // Saldo lógico: passar do saldo em aberto (60,00) é recusado; sem valor, a intenção paga o saldo.
    await assert.rejects(() => payments.createPaymentIntent({ financialEntryId: entry.id, amount: '70.00' }, tenant.userId, t), (e) => e.code === 'FINANCE_PAYMENT_INTENT_AMOUNT_EXCEEDS_BALANCE');
    const second = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    assert.equal(second.snapshotJson.amount, '60.00');
    assert.equal(second.installmentNumber, 2);
    await payments.approvePaymentIntent(second.id, approver.id, t);
    await submitAndConfirm(t, second.id, '60.00');
    assert.equal((await FinancialEntry.findByPk(entry.id, { transaction: t })).status, 'SETTLED');
  });
});

test('M4-G§3/G§5/L3/L5: estados do Guia (DRAFT -> PENDING_APPROVAL -> APPROVED -> EXECUTING -> CONFIRMED) e evento finance.payment.execution_requested', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await agedAccount(t);
    const entry = await payable(t, 210, { bankAccountId: acc.id });
    const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    const trail = await AuditLog.findAll({ where: { entityType: 'PaymentIntent', entityId: intent.id }, order: [['occurredAt', 'ASC']], transaction: t });
    assert.equal(trail[0].afterJson.status, 'DRAFT');
    assert.equal(intent.status, 'PENDING_APPROVAL');
    await payments.approvePaymentIntent(intent.id, (await newUser(t, 'aprovador-estado')).id, t);
    const prepared = await bankSubmission.prepareBankSubmission(intent.id, 'PIX', { userId: tenant.userId }, t);
    assert.equal(prepared.intent.status, 'EXECUTING');
    assert.equal(prepared.intent.submissionPhase, 'SUBMITTING');
    const event = await OutboxEvent.findOne({ where: { aggregateId: intent.id, eventType: 'finance.payment.execution_requested' }, transaction: t });
    assert.ok(event, 'o pedido de execução entra no outbox na mesma transação');
    assert.deepEqual(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'CONFIRMED', 'FAILED', 'CANCELED'], require('../src/modules/finance/domain/payment-intent').STATUSES);
  });
});

test('M4-G§1.6/FIN-005 (V2-P2, P9): o risco vem do valor, nunca do pedido — LOW pedido para R$ 1.000.000,00 vira CRITICAL, 2 aprovadores com MFA', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t, 1000000);
    const request = await approvals.createApprovalRequest({ ...T(), relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' }, tenant.userId, t);
    assert.equal(request.riskLevel, 'CRITICAL');
    assert.equal(request.requiredApprovals, 2);
    assert.ok(request.snapshotHash && request.snapshotJson, 'approval_request guarda o retrato e o hash (Caderno §5)');
    const a1 = await newUser(t, 'p9-a1');
    await assert.rejects(() => approvals.decideApprovalStep(request.id, { decision: 'APPROVED' }, a1.id, t), (e) => /^MFA_/.test(e.code));
    await comMfaRecente(a1.id, T(), t);
    await approvals.decideApprovalStep(request.id, { decision: 'APPROVED' }, a1.id, t);
    assert.equal(await approvals.isApprovalRequestApproved('FinancialEntry', entry.id, t), false, 'uma pessoa não basta no risco crítico');
    const a2 = await newUser(t, 'p9-a2');
    await comMfaRecente(a2.id, T(), t);
    await approvals.decideApprovalStep(request.id, { decision: 'APPROVED' }, a2.id, t);
    assert.equal(await approvals.isApprovalRequestApproved('FinancialEntry', entry.id, t), true);
  });
});

test('M4-§8.5/§8.6: intenção de R$ 120.000,00 (HIGH) exige 2 aprovadores distintos com MFA recente; quem preparou não aprova', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await agedAccount(t);
    const entry = await payable(t, 120000, { bankAccountId: acc.id });
    const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    const approval = await ApprovalRequest.findByPk(intent.approvalRequestId, { transaction: t });
    assert.deepEqual([approval.riskLevel, approval.requiredApprovals, approval.riskSource], ['HIGH', 2, 'PARAMETERS']);
    await assert.rejects(() => payments.approvePaymentIntent(intent.id, tenant.userId, t), (e) => e.code === 'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN');
    const a1 = await newUser(t, 'high-a1');
    await assert.rejects(() => payments.approvePaymentIntent(intent.id, a1.id, t), (e) => /^MFA_/.test(e.code));
    await comMfaRecente(a1.id, T(), t);
    const afterOne = await payments.approvePaymentIntent(intent.id, a1.id, t);
    assert.equal(afterOne.status, 'PENDING_APPROVAL', 'uma aprovação de duas');
    await assert.rejects(() => payments.approvePaymentIntent(intent.id, a1.id, t), (e) => e.code === 'FINANCE_APPROVAL_DUPLICATE_DECISION');
    const a2 = await newUser(t, 'high-a2');
    await comMfaRecente(a2.id, T(), t);
    assert.equal((await payments.approvePaymentIntent(intent.id, a2.id, t)).status, 'APPROVED');
  });
});

test('M4-G§1.6: as faixas são parâmetros da empresa e a versão publicada da REG-FIN-002 decide risco e aprovadores quando define', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await gravarParametro('pagamentos.faixa.baixo_ate', 100, tenant, t);
    const e1 = await payable(t, 150);
    const r1 = await approvals.createApprovalRequest({ ...T(), relatedEntityType: 'FinancialEntry', relatedEntityId: e1.id }, tenant.userId, t);
    assert.equal(r1.riskLevel, 'MEDIUM', 'R$ 150 passa do limite do risco baixo gravado (R$ 100)');

    // REG-FIN-002 publicada (as versões que a empresa já tenha saem de vigência nesta transação desfeita).
    await sequelize.query("UPDATE core.rule_versions SET status = 'RETIRED' WHERE rule_id IN (SELECT id FROM core.rules WHERE code = 'REG-FIN-002' AND company_id = :c) AND status = 'PUBLISHED'", { replacements: { c: tenant.companyId }, transaction: t });
    let rule = await Rule.findOne({ where: { code: 'REG-FIN-002', companyId: tenant.companyId }, transaction: t });
    if (!rule) rule = await Rule.create({ ...T(), code: 'REG-FIN-002', name: 'Limite de aprovação de pagamento', domain: 'finance', createdBy: tenant.userId }, { transaction: t });
    const cond = { fact: 'finance.amount', op: '>', value: 1000 };
    const version = await RuleVersion.create({ ...T(), ruleId: rule.id, versionNumber: 900 + Math.floor(Math.random() * 90), conditionAstJson: cond, contentHash: uniqueSuffix().padEnd(64, '0').slice(0, 64), actionJson: { riskLevel: 'CRITICAL', requiredApprovals: 3 }, effectiveFrom: new Date(Date.now() - 1000), status: 'PUBLISHED', publishedByUserId: tenant.userId, createdBy: tenant.userId }, { transaction: t });
    await RuleScope.create({ ...T(), ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7, createdBy: tenant.userId }, { transaction: t });
    await RulePublication.create({ ...T(), ruleVersionId: version.id, publishedByUserId: tenant.userId, publishedAt: new Date(), createdBy: tenant.userId }, { transaction: t });
    const e2 = await payable(t, 2000);
    const r2 = await approvals.createApprovalRequest({ ...T(), relatedEntityType: 'FinancialEntry', relatedEntityId: e2.id }, tenant.userId, t);
    assert.deepEqual([r2.riskLevel, r2.requiredApprovals, r2.riskSource, r2.ruleVersionId], ['CRITICAL', 3, 'RULE', version.id]);
  });
});

async function manualIntent(t, amount) {
  const entry = await payable(t, amount);
  await settlementEvidence.attachSettlementEvidence(entry.id, await createManualSettlementEvidence(tenant, tenant.userId, t), tenant.userId, t);
  const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
  await payments.approvePaymentIntent(intent.id, (await newUser(t, 'aprovador-manual')).id, t);
  return { entry, intent };
}

test('FIN-TS-002 / Guia §5: a segunda execução da mesma intenção devolve o resultado existente (replay), sem segunda baixa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { entry, intent } = await manualIntent(t, 75);
    const first = await payments.executePaymentIntent(intent.id, tenant.userId, t, {});
    assert.equal(first.intent.status, 'CONFIRMED');
    const second = await payments.executePaymentIntent(intent.id, tenant.userId, t, {});
    assert.equal(second.replayed, true);
    assert.equal(second.intent.id, intent.id);
    assert.equal(second.entry.id, entry.id);
    const executions = await AuditLog.count({ where: { entityType: 'PaymentIntent', entityId: intent.id, action: 'finance.payment_intent.execute' }, transaction: t });
    assert.equal(executions, 1, 'uma única execução registrada');
  });
});

test('M4-§8.12: valor confirmado pelo banco diferente do aprovado não confirma e abre anomaly_case (uma vez por intenção)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await agedAccount(t);
    const entry = await payable(t, 300, { bankAccountId: acc.id });
    const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await payments.approvePaymentIntent(intent.id, (await newUser(t, 'aprovador-divergencia')).id, t);
    await bankSubmission.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, t);
    const routing = await BankPaymentProviderRouting.findOne({ where: { paymentIntentId: intent.id }, transaction: t });
    const r = await payments.confirmBankPayment(routing.externalSubmissionId, 'CONFIRMED', t, { amount: '299.99' });
    assert.equal(r.status, 'EXECUTING', 'não confirma');
    await payments.confirmBankPayment(routing.externalSubmissionId, 'CONFIRMED', t, { amount: '299.99' });
    const cases = await AnomalyCase.findAll({ where: { relatedEntityType: 'PaymentIntent', relatedEntityId: intent.id, caseType: 'BANK_AMOUNT_MISMATCH' }, transaction: t });
    assert.equal(cases.length, 1);
    assert.equal(cases[0].riskLevel, 'CRITICAL');
    assert.equal((await FinancialEntry.findByPk(entry.id, { transaction: t })).status, 'PENDING');
  });
});
