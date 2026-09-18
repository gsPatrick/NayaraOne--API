'use strict';

// Testes de aceite do Marco 4 — segundo lote (M4-08, M4-12, M4-23, M4-24).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const approvalsService = require('../src/features/finance/approvals.service');
const usersService = require('../src/features/users/users.service');
const { User } = require('../src/models');

let tenant;

async function withCommittedTenantTransaction(tenantCtx, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantCtx.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantCtx.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantCtx.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- M4-08: invalidação de aprovação quando a entidade relacionada mudou (lock_version stale) ---
test('M4-08 decideApprovalStep recusa aprovação com expectedLockVersion desatualizado (FINANCE_APPROVAL_STALE)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 500 },
      tenant.userId,
      transaction
    );

    const otherUser = await User.create(
      { name: `HOMO QA M4-08 aprovador ${suffix}`, email: `homo-qa-m408-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    const approvalRequest = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );

    // A entidade muda DEPOIS que o aprovador revisou (viu lockVersion=0) mas ANTES de decidir.
    await financialEntriesService.updateFinancialEntry(entry.id, { description: 'mudou depois da revisão' }, tenant.userId, transaction);

    await assert.rejects(
      () =>
        approvalsService.decideApprovalStep(
          approvalRequest.id,
          { decision: 'APPROVED', expectedLockVersion: 0 },
          otherUser.id,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_APPROVAL_STALE'); return true; },
      'aprovação com lockVersion desatualizado precisa ser recusada — dado mudou depois da revisão'
    );
  });
});

// --- M4-12: importação de transação bancária idempotente (não duplica pelo mesmo ID externo) ---
test('M4-12 createBankTransaction bloqueia reimportação da mesma transação (externalTransactionId único)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', accountNumber: `M412-${suffix}` },
      tenant.userId,
      transaction
    );
    const externalId = `webhook-${suffix}`;

    const first = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, externalTransactionId: externalId, amount: 250, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    assert.ok(first.id);

    await assert.rejects(
      () =>
        bankTransactionsService.createBankTransaction(
          { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, externalTransactionId: externalId, amount: 250, transactionDate: new Date() },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_TRANSACTION_DUPLICATE'); return true; },
      'reenviar o mesmo webhook/import bancário não pode duplicar a transação'
    );
  });
});

// --- M4-23: idempotência de lançamento financeiro (não duplica pela mesma idempotencyKey) ---
test('M4-23 createFinancialEntry com a mesma idempotencyKey não duplica o lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const idempotencyKey = `m423-${suffix}`;

    const first = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 700, idempotencyKey },
      tenant.userId,
      transaction
    );
    assert.ok(first.id);

    await assert.rejects(
      () =>
        financialEntriesService.createFinancialEntry(
          { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 700, idempotencyKey },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_DUPLICATE_PAYMENT'); return true; },
      'reprocessar a mesma idempotencyKey não pode criar um segundo lançamento'
    );
  });
});

// --- M4-24: concorrência real em aprovação — o MESMO aprovador tentando decidir duas vezes ao
// mesmo tempo (ex.: duplo-clique) não pode contar a decisão em dobro ---
test('M4-24 duas tentativas concorrentes do MESMO aprovador decidindo a mesma solicitação: só uma conta', async () => {
  const suffix = uniqueSuffix();
  let entry;
  let approvalRequest;
  let approver;
  try {
    entry = await withCommittedTenantTransaction(tenant, (t) =>
      financialEntriesService.createFinancialEntry(
        { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 9000 },
        tenant.userId,
        t
      )
    );
    approver = await withCommittedTenantTransaction(tenant, (t) =>
      User.create({ name: `HOMO QA M4-24 ${suffix}`, email: `homo-qa-m424-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' }, { transaction: t })
    );
    approvalRequest = await withCommittedTenantTransaction(tenant, (t) =>
      approvalsService.createApprovalRequest(
        { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
        tenant.userId,
        t
      )
    );

    const [resultA, resultB] = await Promise.allSettled([
      withCommittedTenantTransaction(tenant, (t) => approvalsService.decideApprovalStep(approvalRequest.id, { decision: 'APPROVED' }, approver.id, t)),
      withCommittedTenantTransaction(tenant, (t) => approvalsService.decideApprovalStep(approvalRequest.id, { decision: 'APPROVED' }, approver.id, t)),
    ]);

    const succeeded = [resultA, resultB].filter((r) => r.status === 'fulfilled');
    assert.equal(succeeded.length, 1, 'duplo-clique do mesmo aprovador não pode registrar duas decisões — exatamente uma deve vencer a corrida');

    const { ApprovalStep } = require('../src/models');
    const steps = await withCommittedTenantTransaction(tenant, (t) => ApprovalStep.findAll({ where: { approvalRequestId: approvalRequest.id }, transaction: t }));
    assert.equal(steps.length, 1, 'não pode existir mais de uma ApprovalStep do mesmo aprovador para a mesma solicitação');

    const final = await withCommittedTenantTransaction(tenant, (t) => approvalsService.getApprovalRequest(approvalRequest.id, t));
    assert.equal(final.status, 'APPROVED');
  } finally {
    await withCommittedTenantTransaction(tenant, async (t) => {
      const { ApprovalStep, ApprovalRequest } = require('../src/models');
      if (approvalRequest) {
        await ApprovalStep.destroy({ where: { approvalRequestId: approvalRequest.id }, force: true, transaction: t });
        await ApprovalRequest.destroy({ where: { id: approvalRequest.id }, force: true, transaction: t });
      }
    }).catch(() => {});
    if (approver) await approver.destroy({ force: true }).catch(() => {});
  }
});
