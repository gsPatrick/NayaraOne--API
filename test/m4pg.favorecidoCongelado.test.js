'use strict';

// M4PG — Caderno M4 §9 "Favorecido e dados bancários usados em payment_intent ficam congelados no snapshot. Qualquer troca de
// banco/agência/conta/chave PIX/beneficiário invalida toda aprovação anterior"; §17 "Favorecido alterado -> Invalida approvals + alerta";
// FIN-TS-003; Guia §3 (beneficiarySnapshot no retrato que gera o snapshotHash), §5 (assertSnapshotStillValid), §16.3 e §18.4.
// Reproduz as sondas V2-P1 (verificador 2) e P7 (verificador 1): na base 41addaa2 a intenção continuava APPROVED e o envio ao banco saía
// com a chave PIX nova. Camada de serviço, banco descartável, tudo com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const fe = require('../src/modules/finance/application/services/financial-entry.service');
const bankAccounts = require('../src/modules/finance/application/services/bank-accounts.service');
const payments = require('../src/modules/finance/application/services/payment.service');
const bankSubmission = require('../src/modules/finance/application/services/bank-submission.service');
const approvals = require('../src/modules/finance/application/services/approvals.service');
const { User, PaymentIntent, ApprovalRequest, AnomalyCase } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const EVIDENCE = { source: 'PERSON_STATEMENT', note: 'teste M4PG: favorecido informou a troca' };

async function agedAccount(t, s) {
  const acc = await bankAccounts.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '341', agency: '0001', accountNumber: `PG-${s}`, pixKey: `pix-original-${s}@m4pg.dev` },
    tenant.userId, t);
  await sequelize.query("UPDATE finance.bank_accounts SET status = 'ACTIVE', created_at = now() - interval '60 days', updated_at = now() - interval '60 days' WHERE id = :id",
    { replacements: { id: acc.id }, transaction: t });
  return acc;
}

async function payable(t, amount, bankAccountId) {
  const cc = await createTestCostCenter(tenant, t);
  return fe.createFinancialEntry({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `m4pg favorecido ${uniqueSuffix()}`, costCenterId: cc.id, bankAccountId }, tenant.userId, t);
}

const newUser = (t, label) => User.create({ name: `M4PG ${label}`, email: `m4pg-${label}-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });

async function approvedIntent(t, s, amount = 900) {
  const acc = await agedAccount(t, s);
  const entry = await payable(t, amount, acc.id);
  const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
  const approver = await newUser(t, 'aprovador');
  await payments.approvePaymentIntent(intent.id, approver.id, t);
  return { acc, entry, intent, approver };
}

test('M4-§9/FIN-TS-003 (V2-P1): trocar a chave PIX e a conta DEPOIS da aprovação invalida a intenção e o envio ao banco é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const { acc, intent } = await approvedIntent(t, s);
    assert.equal((await PaymentIntent.findByPk(intent.id, { transaction: t })).status, 'APPROVED');

    await bankAccounts.updateBankAccount(acc.id, { pixKey: `pix-ATACANTE-${s}@m4pg.dev`, accountNumber: `ATK-${s}`, changeEvidence: EVIDENCE }, tenant.userId, t);
    const after1 = await PaymentIntent.findByPk(intent.id, { transaction: t });
    assert.notEqual(after1.status, 'APPROVED', 'a aprovação anterior não pode continuar valendo depois da troca do favorecido');
    assert.match(after1.cancelReason || '', /Favorecido alterado/);

    // Mesmo com o resfriamento vencido, a ordem ao banco não sai (nem com os dados novos, nem com os antigos).
    await sequelize.query("UPDATE finance.bank_accounts SET status = 'ACTIVE', updated_at = now() - interval '100 hours' WHERE id = :id", { replacements: { id: acc.id }, transaction: t });
    await assert.rejects(() => bankSubmission.prepareBankSubmission(intent.id, 'PIX', { userId: tenant.userId }, t), (e) => /^FINANCE_PAYMENT_INTENT_/.test(e.code));
    const sent = await PaymentIntent.findByPk(intent.id, { transaction: t });
    assert.notEqual(sent.status, 'EXECUTING');

    // §17 "+ alerta": caso de anomalia aberto para a conta.
    const alert = await AnomalyCase.findOne({ where: { relatedEntityType: 'BankAccount', relatedEntityId: acc.id, caseType: 'BENEFICIARY_CHANGED_AFTER_APPROVAL' }, transaction: t });
    assert.ok(alert, 'a troca do favorecido com pagamento aprovado abre o alerta (§17)');
    // O pedido de aprovação da intenção também deixou de valer.
    const approval = await ApprovalRequest.findByPk(after1.approvalRequestId, { transaction: t });
    assert.equal(approval.status, 'STALE');
  });
});

test('M4-§21.4/G§3/G§20.5: o retrato aprovado e o hash incluem o favorecido (banco, agência, conta, PIX), congelados no PREPARE', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const acc = await agedAccount(t, s);
    const entry = await payable(t, 321.5, acc.id);
    const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    const frozen = intent.beneficiarySnapshot;
    assert.ok(frozen, 'o favorecido é congelado na preparação, não no envio');
    assert.deepEqual(
      { bankCode: frozen.bankCode, branch: frozen.branch, account: frozen.account, pixKey: frozen.pixKey },
      { bankCode: '341', branch: '0001', account: `PG-${s}`, pixKey: `pix-original-${s}@m4pg.dev` }
    );
    assert.deepEqual(intent.snapshotJson.beneficiary && intent.snapshotJson.beneficiary.pixKey, `pix-original-${s}@m4pg.dev`, 'o favorecido faz parte do retrato que gera o hash');
    // O pedido de aprovação guarda o MESMO retrato e o MESMO hash (Caderno §5 approval_requests "Snapshot de aprovação").
    const approval = await ApprovalRequest.findByPk(intent.approvalRequestId, { transaction: t });
    assert.equal(approval.snapshotHash, intent.snapshotHash);
    assert.equal(approval.snapshotJson.beneficiary.account, `PG-${s}`);
  });
});

test('M4-G§18.4: favorecido mudado por fora do serviço (direto no banco) também é recusado na aprovação e no envio, com os campos que mudaram', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const acc = await agedAccount(t, s);
    const entry = await payable(t, 250, acc.id);
    const intent = await payments.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await sequelize.query('UPDATE finance.bank_accounts SET pix_key = :pix WHERE id = :id', { replacements: { id: acc.id, pix: `outra-${s}@m4pg.dev` }, transaction: t });
    const approver = await newUser(t, 'aprovador-direto');
    await assert.rejects(() => payments.approvePaymentIntent(intent.id, approver.id, t), (e) => {
      assert.equal(e.code, 'FINANCE_PAYMENT_INTENT_STALE');
      assert.ok(e.details.changedFields.includes('beneficiary.pixKey'), JSON.stringify(e.details));
      return true;
    });
  });
});

test('M4-§9: sem troca, o envio ao banco leva exatamente o favorecido congelado na aprovação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const { intent } = await approvedIntent(t, s, 480);
    const prepared = await bankSubmission.prepareBankSubmission(intent.id, 'PIX', { userId: tenant.userId }, t);
    assert.equal(prepared.intent.status, 'EXECUTING');
    assert.equal(prepared.intent.beneficiarySnapshot.pixKey, `pix-original-${s}@m4pg.dev`);
    assert.equal(prepared.intent.beneficiarySnapshot.account, `PG-${s}`);
  });
});

test('M4-§9: a troca do favorecido também invalida a aprovação de baixa (sem intenção) dos lançamentos que pagam essa conta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const acc = await agedAccount(t, s);
    const entry = await payable(t, 150, acc.id);
    const request = await approvals.createApprovalRequest({ groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id }, tenant.userId, t);
    const approver = await newUser(t, 'aprovador-baixa');
    await approvals.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, t);
    assert.equal(await approvals.isApprovalRequestApproved('FinancialEntry', entry.id, t), true);
    await bankAccounts.updateBankAccount(acc.id, { agency: '9999', changeEvidence: EVIDENCE }, tenant.userId, t);
    assert.equal(await approvals.isApprovalRequestApproved('FinancialEntry', entry.id, t), false, 'a aprovação anterior à troca não vale mais');
  });
});
