'use strict';

// GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07, Marco 7/Procurement): trocar o
// bankAccountId de um lançamento PENDING via updateFinancialEntry não passava por nenhuma
// checagem extra — um payable podia ser redirecionado para uma conta diferente, já fora do
// cooldown antifraude, e liquidado sem nenhum alerta. Também: `clearManualReview`
// (financeAntifraud.service.js) já existia mas nunca foi exposta por rota HTTP nenhuma.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const antifraudService = require('../src/features/finance/financeAntifraud.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createActiveBankAccount(transaction, suffix) {
  const account = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `redir-${suffix}` },
    tenant.userId,
    transaction
  );
  account.status = 'ACTIVE';
  await account.save({ transaction });
  return account;
}

test('FIN-REDIR-01: trocar bankAccountId de um lançamento PENDING já com conta definida exige revisão manual', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const costCenter = await createTestCostCenter(tenant, transaction);
    const accountA = await createActiveBankAccount(transaction, `a-${suffix}`);
    const accountB = await createActiveBankAccount(transaction, `b-${suffix}`);

    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: accountA.id,
        costCenterId: costCenter.id,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 500,
        description: `Fornecedor redirect ${suffix}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(entry.requiresManualReview, false);

    const updated = await financialEntriesService.updateFinancialEntry(
      entry.id,
      { bankAccountId: accountB.id },
      tenant.userId,
      transaction
    );
    assert.equal(updated.bankAccountId, accountB.id);
    assert.equal(updated.requiresManualReview, true, 'trocar de conta um lançamento que já tinha conta definida precisa reter para revisão manual');
    assert.ok(updated.manualReviewReason);

    // Liquidar continua bloqueado enquanto não for liberado por um revisor humano.
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
        return true;
      }
    );

    const cleared = await antifraudService.clearManualReview(entry.id, tenant.userId, transaction, 'Confirmado com o fornecedor por telefone.');
    assert.equal(cleared.requiresManualReview, false);
    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);
    assert.equal(settled.status, 'SETTLED');
  });
});

test('FIN-REDIR-02: definir bankAccountId pela primeira vez (ainda null) NÃO exige revisão manual', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const costCenter = await createTestCostCenter(tenant, transaction);
    const account = await createActiveBankAccount(transaction, `first-${suffix}`);

    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        costCenterId: costCenter.id,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 300,
        description: `Sem conta ainda ${suffix}`,
      },
      tenant.userId,
      transaction
    );
    assert.equal(entry.bankAccountId, null);

    const updated = await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: account.id }, tenant.userId, transaction);
    assert.equal(updated.bankAccountId, account.id);
    assert.equal(updated.requiresManualReview, false, 'primeira atribuição de conta não é "redirecionamento"');
  });
});

test('FIN-REDIR-03: reenviar o MESMO bankAccountId (sem trocar de fato) não exige revisão manual', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const costCenter = await createTestCostCenter(tenant, transaction);
    const account = await createActiveBankAccount(transaction, `same-${suffix}`);

    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        bankAccountId: account.id,
        costCenterId: costCenter.id,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: 300,
        description: `Mesma conta ${suffix}`,
      },
      tenant.userId,
      transaction
    );

    const updated = await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: account.id, description: 'Mesma conta, só mudando a descrição' }, tenant.userId, transaction);
    assert.equal(updated.requiresManualReview, false);
  });
});
