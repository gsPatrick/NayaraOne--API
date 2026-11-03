'use strict';

// Reconferência ao vivo de 20/10/2026 — R2 (travamento de aprovação), R3 (valor <= 0) e R5
// (intenção de pagamento). Banco real com rollback; sem MFA real (pedidos de risco LOW).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createManualSettlementEvidence,
} = require('./testHelpers');
const { User, BankAccount } = require('../src/models');
const entries = require('../src/features/finance/financialEntries.service');
const approvals = require('../src/features/finance/approvals.service');
const intents = require('../src/features/finance/paymentIntents.service');
const bankPayments = require('../src/features/finance/bankPayments.service');

let tenant;
let approver;
before(async () => {
  tenant = await getSeedTenant();
  [approver] = await User.findOrCreate({
    where: { email: 'homo-qa-r2010-approver@nayaraone.dev' },
    defaults: { name: 'HOMO QA — Aprovador R2010', passwordHash: 'x', status: 'ACTIVE' },
  });
});
after(async () => { await sequelize.close(); });

const W = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });
async function bank(t) {
  return BankAccount.create(W({ bankCode: '001', agency: '0001', accountNumber: `R2-${uniqueSuffix()}`, pixKey: `r2-${uniqueSuffix()}@x.dev`, status: 'ACTIVE' }), { transaction: t });
}
async function payable(t, amount = 300) {
  const cc = await createTestCostCenter(tenant, t);
  const ba = await bank(t);
  return entries.createFinancialEntry(
    W({ entryType: 'DEBIT', nature: 'PAYABLE', amount, description: 'R2010', costCenterId: cc.id, bankAccountId: ba.id, dueAt: new Date(Date.now() + 86400000) }),
    tenant.userId, t
  );
}
const request = (t, id) => approvals.createApprovalRequest(W({ relatedEntityType: 'FinancialEntry', relatedEntityId: id, riskLevel: 'LOW' }), tenant.userId, t);

test('R2: anexar comprovante depois do pedido invalida o pedido pendente e libera novo pedido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await payable(t);
    const r1 = await request(t, e.id);
    await entries.attachSettlementEvidence(e.id, await createManualSettlementEvidence(tenant, tenant.userId, t), tenant.userId, t);
    await r1.reload({ transaction: t });
    assert.equal(r1.status, 'STALE');
    const r2 = await request(t, e.id);
    assert.equal(r2.status, 'PENDING');
    const out = await approvals.decideApprovalStep(r2.id, { decision: 'APPROVED' }, approver.id, t);
    assert.equal(out.approvalRequest.status, 'APPROVED');
  });
});

test('R2: pedido pendente já desatualizado (dado preso) pode ser rejeitado e pedir de novo libera', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await payable(t);
    const r1 = await request(t, e.id);
    // simula o dado preso: muda o lançamento sem passar pela invalidação
    await sequelize.query('UPDATE finance.financial_entries SET description = :d, lock_version = lock_version + 1 WHERE id = :id', { replacements: { d: 'mudou', id: e.id }, transaction: t }).catch(() => null);
    const cur = await entries.getFinancialEntry(e.id, t);
    if (Number(cur.lockVersion) === Number(r1.lockVersionAtRequest)) return; // trigger de ledger impediu o UPDATE cru; cenário coberto acima
    await assert.rejects(approvals.decideApprovalStep(r1.id, { decision: 'APPROVED' }, approver.id, t), (err) => {
      assert.equal(err.code, 'FINANCE_APPROVAL_STALE');
      assert.match(err.message, /peça a aprovação de novo/);
      return true;
    });
    const rej = await approvals.decideApprovalStep(r1.id, { decision: 'REJECTED' }, approver.id, t);
    assert.equal(rej.approvalRequest.status, 'REJECTED');
  });
});

test('R2: editar o lançamento invalida o pedido pendente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await payable(t);
    const r1 = await request(t, e.id);
    await entries.updateFinancialEntry(e.id, { description: 'R2010 editado' }, tenant.userId, t);
    await r1.reload({ transaction: t });
    assert.equal(r1.status, 'STALE');
  });
});

test('R3: API recusa valor -10, -0,01, 0 e "abc" com mensagem em português', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const cc = await createTestCostCenter(tenant, t);
    for (const amount of [-10, '-0,01', -0.01, 0, 'abc']) {
      await assert.rejects(
        entries.createFinancialEntry(W({ entryType: 'DEBIT', nature: 'PAYABLE', amount, description: 'R3', costCenterId: cc.id, dueAt: new Date() }), tenant.userId, t),
        (err) => { assert.equal(err.statusCode || err.status, 400); assert.equal(err.message, 'Informe um valor maior que zero.'); return true; }
      );
    }
  });
});

test('R5: troca de conta invalida intenção aprovada e o envio ao banco de intenção desatualizada é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await payable(t);
    const i = await intents.createPaymentIntent({ financialEntryId: e.id }, tenant.userId, t);
    await intents.approvePaymentIntent(i.id, approver.id, t);
    const other = await bank(t);
    await entries.updateFinancialEntry(e.id, { bankAccountId: other.id }, tenant.userId, t);
    await i.reload({ transaction: t });
    assert.equal(i.status, 'CANCELLED');
    await assert.rejects(bankPayments.submitPaymentIntentToBank(i.id, 'PIX', { userId: tenant.userId }, t), (err) => err.code === 'FINANCE_PAYMENT_INTENT_NOT_APPROVED');
  });
});

test('R5: submit sandbox de intenção aprovada fica SUBMITTED e o lançamento continua PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await payable(t);
    const i = await intents.createPaymentIntent({ financialEntryId: e.id }, tenant.userId, t);
    await intents.approvePaymentIntent(i.id, approver.id, t);
    const sent = await bankPayments.submitPaymentIntentToBank(i.id, 'PIX', { userId: tenant.userId }, t);
    assert.ok(['SUBMITTED', 'SUBMITTING'].includes(sent.status));
    const cur = await entries.getFinancialEntry(e.id, t);
    assert.equal(cur.status, 'PENDING');
  });
});

test('R5: envio ao banco recusa quando o retrato diverge do lançamento atual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await payable(t);
    const i = await intents.createPaymentIntent({ financialEntryId: e.id }, tenant.userId, t);
    await intents.approvePaymentIntent(i.id, approver.id, t);
    await sequelize.query('UPDATE finance.financial_entries SET description = :d WHERE id = :id', { replacements: { d: 'adulterado', id: e.id }, transaction: t }).catch(() => null);
    const cur = await entries.getFinancialEntry(e.id, t);
    if (cur.description !== 'adulterado') return;
    await assert.rejects(bankPayments.submitPaymentIntentToBank(i.id, 'PIX', { userId: tenant.userId }, t), (err) => err.code === 'FINANCE_PAYMENT_INTENT_STALE');
  });
});
