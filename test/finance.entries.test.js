'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const approvalsService = require('../src/features/finance/approvals.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;
let secondApproverUserId;

before(async () => {
  tenant = await getSeedTenant();
  // Segundo usuário só pra exercitar maker-checker (não precisa existir permissão/role real
  // pra esses testes — a regra de segregação de funções é sobre "quem solicitou" x "quem
  // decide" no nível de serviço, checada antes de qualquer verificação de permissão HTTP).
  const suffix = uniqueSuffix();
  const [secondUser] = await User.findOrCreate({
    where: { email: `homo-qa-approver-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Segundo aprovador ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  secondApproverUserId = secondUser.id;
});

after(async () => {
  await sequelize.close();
});

async function createEntry(transaction, actorUserId, overrides = {}) {
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 100,
      description: 'HOMO QA — lançamento de teste',
      ...overrides,
    },
    actorUserId,
    transaction
  );
}

test('FIN-004 idempotência: 2ª tentativa com a mesma chave é bloqueada (não duplica pagamento)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const key = `homo-qa-idem-${suffix}`;
    await createEntry(transaction, tenant.userId, { idempotencyKey: key });

    await assert.rejects(
      () => createEntry(transaction, tenant.userId, { idempotencyKey: key }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_DUPLICATE_PAYMENT');
        return true;
      }
    );
  });
});

test('maker-checker: quem solicitou a aprovação não pode decidir a própria solicitação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, tenant.userId);
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'HIGH' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN');
        return true;
      }
    );
  });
});

test('maker-checker: segundo usuário aprova (risco HIGH exige 2 aprovações independentes)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, tenant.userId);
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'HIGH' },
      tenant.userId,
      transaction
    );

    const { approvalRequest: afterFirstStep } = await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, secondApproverUserId, transaction);
    assert.equal(afterFirstStep.status, 'PENDING', 'risco HIGH exige 2 aprovações — 1 sozinha não fecha a solicitação');

    await assert.rejects(
      () => approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, secondApproverUserId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_APPROVAL_DUPLICATE_DECISION');
        return true;
      }
    );
  });
});

test('conciliação: valores divergentes entre lançamento e extrato são bloqueados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: '12345-6' },
      tenant.userId,
      transaction
    );
    const entry = await createEntry(transaction, tenant.userId, { amount: 150.5, bankAccountId: account.id });
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 99.9, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => reconciliationService.matchReconciliation(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry.id, bankTransactionId: bankTx.id },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_AMOUNT_MISMATCH');
        return true;
      }
    );
  });
});

test('conciliação: valores batendo concilia; conciliar de novo o mesmo lançamento é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: '12345-6' },
      tenant.userId,
      transaction
    );
    const entry = await createEntry(transaction, tenant.userId, { amount: 150.5, bankAccountId: account.id });
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 150.5, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    const bankTx2 = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 150.5, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    const reconciliation = await reconciliationService.matchReconciliation(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry.id, bankTransactionId: bankTx.id },
      tenant.userId,
      transaction
    );
    assert.ok(reconciliation.id);

    await assert.rejects(
      () => reconciliationService.matchReconciliation(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry.id, bankTransactionId: bankTx2.id },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED');
        return true;
      }
    );
  });
});

test('estorno: lançamento estornado não pode ser estornado de novo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, tenant.userId);
    await financialEntriesService.reverseFinancialEntry(entry.id, 'HOMO QA — estorno de teste', tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.reverseFinancialEntry(entry.id, 'HOMO QA — segunda tentativa', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_ALREADY_REVERSED');
        return true;
      }
    );
  });
});
