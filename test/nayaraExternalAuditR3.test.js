'use strict';

/**
 * nayaraExternalAuditR3.test.js — 3ª rodada de achados da auditoria técnica independente da
 * Nayara (18/10/2026, reproduzidos por ela em testes isolados sobre o commit 787eaf3).
 * São variantes de achados anteriores: a correção original fechou uma ponta e deixou a outra.
 *
 *  R3-1 (variante do A07): prazo jurídico com responsável PRÓPRIO, em processo SEM
 *        responsável — o job contava o alerta mas não criava Notification pra ninguém.
 *  R3-2 (variante do A10): isApprovalRequestApproved aceitava aprovação dada sobre a versão 1
 *        do lançamento mesmo depois de ele mudar pra versão 2 (staleness validada só na
 *        decisão, nunca no CONSUMO da aprovação).
 *  R3-3 (variante do A04): garantia ACTIVE com vigência que só COMEÇA no futuro (startsAt >
 *        hoje) passava pelo gate de entrega de chaves — o A04 só tinha fechado o endsAt.
 *
 * Todos contra Postgres real, RLS ativo, transação com rollback — mesmo caminho do runtime.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  approveFinancialEntryForSettlement,
  createManualSettlementEvidence,
} = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');
const AppError = require('../src/utils/AppError');
const { Notification, User } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// ---------------------------------------------------------------------------------------------
// R3-1 — prazo com responsável próprio em processo sem responsável: Notification é criada
// ---------------------------------------------------------------------------------------------

test('R3-1: prazo OVERDUE com responsável próprio, processo SEM responsável — job cria Notification pro responsável do PRAZO', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const [deadlineOwner] = await User.findOrCreate({
      where: { email: `homo-qa-r3-deadline-owner-${suffix}@nayaraone.dev` },
      defaults: { name: `HOMO QA — Dono do prazo R3 ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    });

    // Processo deliberadamente SEM responsibleUserId — o cenário exato da auditora.
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `R3-1 ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(legalCase.responsibleUserId ?? null, null, 'pré-condição: processo sem responsável');

    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      {
        description: `R3-1 prazo vencido ${suffix}`,
        dueAt: new Date('2020-01-01'),
        sourceDocument: 'decisão fictícia (teste automatizado)',
        responsibleUserId: deadlineOwner.id,
      },
      tenant.userId,
      transaction
    );

    const before = await Notification.count({ where: { userId: deadlineOwner.id }, transaction });
    const run = await processDeadlinesInTransaction(transaction);
    assert.ok(run.alerted >= 1, 'o prazo vencido precisa ter sido alertado');

    const afterCount = await Notification.count({ where: { userId: deadlineOwner.id }, transaction });
    assert.equal(
      afterCount,
      before + 1,
      'o alerta contado tem que virar Notification real pro responsável do PRAZO, mesmo sem responsável no processo'
    );

    await deadline.reload({ transaction });
    assert.equal(deadline.lastAlertedSeverity, 'OVERDUE');
  });
});

test('R3-1 (controle): prazo sem responsável próprio continua notificando o responsável do PROCESSO', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `R3-1b ${suffix}`, responsibleUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    // Prazo futuro (não exige responsável próprio) que entra na janela DUE_SOON.
    await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `R3-1b prazo próximo ${suffix}`, dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000), sourceEvent: 'teste automatizado' },
      tenant.userId,
      transaction
    );

    const before = await Notification.count({ where: { userId: tenant.userId }, transaction });
    const run = await processDeadlinesInTransaction(transaction);
    assert.ok(run.alerted >= 1);
    const afterCount = await Notification.count({ where: { userId: tenant.userId }, transaction });
    assert.ok(afterCount >= before + 1, 'fallback pro responsável do processo preservado');
  });
});

// ---------------------------------------------------------------------------------------------
// R3-2 — aprovação dada sobre a versão 1 não vale depois do lançamento mudar pra versão 2
// ---------------------------------------------------------------------------------------------

async function createPayableEntry(transaction, suffix) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  const account = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `r3-${suffix}` },
    tenant.userId,
    transaction
  );
  account.status = 'ACTIVE';
  await account.save({ transaction });
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 100,
      description: `R3-2 ${suffix}`,
      costCenterId: costCenter.id,
      bankAccountId: account.id,
    },
    tenant.userId,
    transaction
  );
}

test('R3-2: lançamento editado DEPOIS da aprovação invalida a aprovação — baixa integral e parcial recusadas', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await createPayableEntry(transaction, suffix);

    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);

    // Edita o lançamento APÓS a aprovação — lockVersion incrementa (optimistic locking do
    // Sequelize), e a aprovação dada sobre a versão anterior deixa de valer.
    await financialEntriesService.updateFinancialEntry(
      entry.id,
      { description: `R3-2 editado após aprovação ${suffix}` },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL');
        return true;
      },
      'baixa integral com aprovação obsoleta (versão anterior) tem que ser recusada'
    );

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(entry.id, 40, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL');
        return true;
      },
      'baixa parcial com aprovação obsoleta também tem que ser recusada'
    );
  });
});

test('R3-2 (controle): aprovação sem edição posterior continua liberando a baixa normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await createPayableEntry(transaction, suffix);
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);
    // F03 (conferência 18/10/2026): baixa direta de pagamento bancário exige comprovante.
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, transaction);
    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction, { manualSettlement });
    assert.equal(settled.status, 'SETTLED');
  });
});

test('R3-2 (reaprovação): depois de editar, uma NOVA aprovação sobre a versão atual volta a liberar a baixa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const entry = await createPayableEntry(transaction, suffix);

    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);
    await financialEntriesService.updateFinancialEntry(
      entry.id,
      { description: `R3-2c editado ${suffix}` },
      tenant.userId,
      transaction
    );

    // Nova rodada de revisão sobre a versão ATUAL — caminho legítimo pós-edição.
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, transaction);
    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction, { manualSettlement });
    assert.equal(settled.status, 'SETTLED');
  });
});

// ---------------------------------------------------------------------------------------------
// R3-3 — garantia ACTIVE com vigência futura não libera chave
// ---------------------------------------------------------------------------------------------

async function createActiveLeaseWithInspection(transaction) {
  const suffix = uniqueSuffix();
  const property = await propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, propertyType: 'RESIDENTIAL', title: `R3 KD ${suffix}`, internalCode: `R3KD-${suffix}` },
    tenant.userId,
    transaction
  );
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', propertyId: property.id, totalValue: 1000 },
    tenant.userId,
    transaction
  );
  contract.status = 'ACTIVE';
  await contract.save({ transaction });

  const landlord = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `R3 Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  const tenantPerson = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `R3 Locatário ${suffix}` },
    tenant.userId,
    transaction
  );
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, transaction);

  const inspection = await inspectionsService.createInspection(
    { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
    tenant.userId,
    transaction
  );
  await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: 'r3-locador' }, tenant.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'r3-locatario' }, tenant.userId, transaction);

  return { contract, inspection, tenantPerson };
}

test('R3-3: garantia ACTIVE com startsAt no FUTURO bloqueia a entrega de chaves', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE', startsAt: tomorrow, endsAt: nextYear },
      tenant.userId,
      transaction
    );
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 1, termSignedByPersonId: tenantPerson.id }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID');
        return true;
      },
      'vigência que só começa amanhã não é garantia vigente hoje'
    );
  });
});

test('R3-3 (controle): garantia ACTIVE com vigência corrente (startsAt ontem, endsAt futuro) libera normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE', startsAt: yesterday, endsAt: nextYear },
      tenant.userId,
      transaction
    );
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    const released = await keyDeliveriesService.releaseKeyDelivery(
      keyDelivery.id,
      { keysCount: 1, termSignedByPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    assert.equal(released.status, 'RELEASED');
  });
});
