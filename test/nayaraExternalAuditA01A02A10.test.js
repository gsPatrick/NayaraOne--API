'use strict';

// Achados A01, A02 e A10 — auditoria técnica independente da Nayara (PDF "Conferência
// complementar Marcos 4 e 5", 15/10/2026, reprodução via fixtures em memória). Reproduzidos
// aqui contra o Postgres real (não fixture em memória), via withRollbackTenantTransaction —
// mesmo caminho de RLS/SET LOCAL da aplicação.
//
// A01 — baixa PARCIAL de um PAYABLE com conta bancária vinculada contornava a exigência de
//       aprovação prévia que a baixa INTEGRAL já respeitava.
// A02 — baixa INTEGRAL não consultava se o período (competência) já estava FECHADO; só a
//       baixa parcial fazia essa checagem.
// A10 — decidir uma ApprovalRequest sem informar expectedLockVersion pulava a checagem de
//       staleness inteira, mesmo que a entidade relacionada tivesse mudado desde a solicitação.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  approveFinancialEntryForSettlement,
  uniqueClosingTestMonth,
  confirmPeriodChecksForTest,
  createManualSettlementEvidence,
  prepareManualSettlement,
} = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const approvalsService = require('../src/features/finance/approvals.service');
const periodClosuresService = require('../src/features/finance/periodClosures.service');
const AppError = require('../src/utils/AppError');
const { User } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createActiveBankAccount(transaction, suffix) {
  const account = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `a01a02a10-${suffix}` },
    tenant.userId,
    transaction
  );
  account.status = 'ACTIVE';
  await account.save({ transaction });
  return account;
}

async function createPayableEntry(transaction, suffix, overrides = {}) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  const account = await createActiveBankAccount(transaction, suffix);
  const entry = await financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 100,
      description: `A01/A02/A10 ${suffix}`,
      costCenterId: costCenter.id,
      bankAccountId: account.id,
      ...overrides,
    },
    tenant.userId,
    transaction
  );
  return { entry, account };
}

test('A01: baixa PARCIAL de PAYABLE com conta bancária sem aprovação prévia é bloqueada (mesmo gate da baixa integral)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createPayableEntry(transaction, suffix);

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(entry.id, 40, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL');
        return true;
      }
    );
  });
});

test('A01 (controle positivo): baixa PARCIAL de PAYABLE com aprovação prévia funciona normalmente', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createPayableEntry(transaction, suffix);
        // F03 (conferência 18/10/2026): além da aprovação, pagamento bancário sem confirmação do
    // banco precisa do comprovante da baixa manual.
    const manualSettlement = await prepareManualSettlement(tenant, entry.id, tenant.userId, transaction);

    const result = await financialEntriesService.settleFinancialEntryPartial(entry.id, 40, tenant.userId, transaction, { manualSettlement });
    assert.equal(result.original.status, 'PARTIALLY_SETTLED');
  });
});

test('A01 (controle negativo): RECEIVABLE parcial continua sem exigir aprovação (regra é só pra PAYABLE)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: 100,
        description: `A01 receivable ${suffix}`,
        resultCenterId: (await require('./testHelpers').createTestResultCenter(tenant, transaction)).id,
        bankAccountId: account.id,
      },
      tenant.userId,
      transaction
    );

    const result = await financialEntriesService.settleFinancialEntryPartial(entry.id, 40, tenant.userId, transaction);
    assert.equal(result.original.status, 'PARTIALLY_SETTLED');
  });
});

test('A02: baixa INTEGRAL em período já FECHADO é bloqueada (mesmo gate da baixa parcial)', async () => {
  const suffix = uniqueSuffix();
  // F02 (conferência 18/10/2026): mês exclusivo + as conferências do Caderno §16 antes de fechar.
  const referenceMonth = uniqueClosingTestMonth();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createPayableEntry(transaction, suffix, { dueAt: `${referenceMonth}-10T00:00:00.000Z` });
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);
    await confirmPeriodChecksForTest(tenant, referenceMonth, tenant.userId, transaction);

    const requested = await periodClosuresService.closePeriod(
      { groupId: tenant.groupId, companyId: tenant.companyId, referenceMonth },
      tenant.userId,
      transaction
    );
    assert.equal(requested.status, 'REVIEW');

    const [approver] = await User.findOrCreate({
      where: { email: `homo-qa-a02-approver-${suffix}@nayaraone.dev` },
      defaults: { name: `HOMO QA A02 Aprovador ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    const closure = await periodClosuresService.approvePeriodClosure(
      { companyId: tenant.companyId, referenceMonth },
      approver.id,
      transaction
    );
    assert.equal(closure.status, 'CLOSED');

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_PERIOD_CLOSED');
        return true;
      }
    );
  });
});

test('A10: decidir aprovação SEM expectedLockVersion é recusada se a entidade mudou desde a solicitação', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createPayableEntry(transaction, suffix);

    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );

    // A entidade muda DEPOIS da solicitação (ex: descrição editada) — lockVersion incrementa.
    entry.description = `A10 editado depois da solicitação ${suffix}`;
    await entry.save({ transaction });

    const [approver] = await User.findOrCreate({
      where: { email: `homo-qa-a10-approver-${suffix}@nayaraone.dev` },
      defaults: { name: `HOMO QA A10 Aprovador ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    });

    // Decide SEM mandar expectedLockVersion — antes do fix, isso pulava a checagem inteira.
    await assert.rejects(
      () => approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_APPROVAL_STALE');
        return true;
      }
    );
  });
});

test('A10 (controle positivo): decidir aprovação sem a entidade ter mudado funciona normalmente', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createPayableEntry(transaction, suffix);

    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );

    const [approver] = await User.findOrCreate({
      where: { email: `homo-qa-a10-ok-${suffix}@nayaraone.dev` },
      defaults: { name: `HOMO QA A10 OK ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    });

    const decided = await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, transaction);
    assert.equal(decided.approvalRequest.status, 'APPROVED');
  });
});
