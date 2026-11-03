'use strict';

/**
 * nayaraExternalAuditMatrixCoverage.test.js — cobre, com execução real (Postgres + RLS, não
 * fixtures em memória), itens da "Seção 4. Matriz de cobertura" da auditoria independente da
 * Nayara (PDF "Auditoria_Marcos4_5_Patrick.pdf", 14/10/2026) marcados "Parcial"/"Não
 * comprovado": garantias (substituição com histórico), reajuste de aluguel (persistência
 * old/new/raw/applied/regra, competência duplicada bloqueada) e utilidades (todos os 7 tipos,
 * não só água/luz, e reembolso real gerando FinancialEntry). Ver
 * Maturacao/AUDITORIA_MARCOS4_5_NAYARA_CHECKLIST.md, Seção 4.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const rentAdjustmentService = require('../src/features/billing/rentAdjustment.service');
const utilitiesService = require('../src/features/billing/utilities.service');
const { File } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseContract(transaction, suffix) {
  const property = await propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, propertyType: 'RESIDENTIAL', title: `MX QA ${suffix}`, internalCode: `MXQA-${suffix}` },
    tenant.userId,
    transaction
  );
  return contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', propertyId: property.id, totalValue: 2000 },
    tenant.userId,
    transaction
  );
}

// --- Garantias: substituição preserva histórico (banco real) ---

test('replaceGuarantee (banco real): garantia antiga vira RELEASED com vínculo à nova, histórico íntegro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    const original = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 1000, status: 'ACTIVE' },
      tenant.userId,
      transaction
    );

    const { oldGuarantee, newGuarantee } = await guaranteesService.replaceGuarantee(
      original.id,
      { guaranteeType: 'INSURANCE', value: 1500, endsAt: '2027-01-01' },
      tenant.userId,
      transaction
    );

    assert.equal(newGuarantee.status, 'ACTIVE');
    assert.equal(newGuarantee.contractId, contract.id);

    const reloadedOld = await guaranteesService.getGuarantee(oldGuarantee.id, transaction);
    assert.equal(reloadedOld.status, 'RELEASED', 'garantia antiga persiste como RELEASED no banco, não só em memória');
    assert.equal(reloadedOld.replacedByGuaranteeId, newGuarantee.id);
    // Histórico íntegro: valor/tipo original da garantia antiga não foi apagado/reescrito.
    assert.equal(reloadedOld.guaranteeType, 'DEPOSIT');
    assert.equal(Number(reloadedOld.value), 1000);

    const all = await guaranteesService.listGuarantees(transaction, { contractId: contract.id });
    assert.equal(all.length, 2, 'as duas garantias (antiga RELEASED + nova ACTIVE) continuam listadas, nenhuma foi excluída');
  });
});

test('replaceGuarantee (banco real): não permite substituir uma garantia já substituída', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    const original = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 1000, status: 'ACTIVE' },
      tenant.userId,
      transaction
    );
    await guaranteesService.replaceGuarantee(original.id, { guaranteeType: 'DEPOSIT', value: 1200 }, tenant.userId, transaction);

    await assert.rejects(
      () => guaranteesService.replaceGuarantee(original.id, { guaranteeType: 'DEPOSIT', value: 1300 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_GUARANTEE_ALREADY_REPLACED');
        return true;
      }
    );
  });
});

// --- Reajuste de aluguel: persistência completa old/new/raw/applied/regra (banco real) ---

function mockAdapter(rawValue) {
  return { getIndex: async () => ({ available: true, rawValue }) };
}

test('requestRentAdjustment (banco real): persiste old/new/raw/applied/ruleVersionId e status APPLIED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);

    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        indexCode: 'IPCA',
        period: '2026-11',
        oldRentAmount: 1000,
      },
      tenant.userId,
      transaction,
      mockAdapter(4.5)
    );

    assert.equal(adjustment.status, 'APPLIED');
    assert.equal(Number(adjustment.rawIndexValue), 4.5);
    assert.equal(Number(adjustment.appliedPercentage), 4.5, 'sem override, applied = raw');
    assert.equal(Number(adjustment.oldRentAmount), 1000);
    assert.equal(Number(adjustment.newRentAmount), 1045);
    assert.ok(adjustment.appliedAt);

    const reloaded = await rentAdjustmentService.getRentAdjustment(adjustment.id, transaction);
    assert.equal(Number(reloaded.newRentAmount), 1045, 'persistido de fato no banco, não só em memória');
  });
});

test('requestRentAdjustment (banco real): appliedPercentageOverride diverge de raw mas raw continua registrado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);

    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        indexCode: 'IPCA',
        period: '2026-11',
        oldRentAmount: 1000,
        appliedPercentageOverride: 3,
      },
      tenant.userId,
      transaction,
      mockAdapter(4.5)
    );

    assert.equal(Number(adjustment.rawIndexValue), 4.5, 'raw do índice é preservado mesmo com negociação manual');
    assert.equal(Number(adjustment.appliedPercentage), 3, 'applied reflete a negociação (override)');
    assert.equal(Number(adjustment.newRentAmount), 1030);
  });
});

test('requestRentAdjustment (banco real): índice indisponível vira PENDING_SOURCE sem inventar percentual', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    const unavailable = { getIndex: async () => ({ available: false }) };

    const adjustment = await rentAdjustmentService.requestRentAdjustment(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, indexCode: 'IGPM', period: '2026-11', oldRentAmount: 1000 },
      tenant.userId,
      transaction,
      unavailable
    );

    assert.equal(adjustment.status, 'PENDING_SOURCE');
    assert.equal(adjustment.rawIndexValue, null);
    assert.equal(adjustment.appliedPercentage, null);
    assert.equal(adjustment.newRentAmount, null);
  });
});

test('requestRentAdjustment (banco real): competência duplicada para o mesmo contrato é bloqueada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    await rentAdjustmentService.requestRentAdjustment(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, indexCode: 'IPCA', period: '2026-11', oldRentAmount: 1000 },
      tenant.userId,
      transaction,
      mockAdapter(4.5)
    );

    await assert.rejects(
      () =>
        rentAdjustmentService.requestRentAdjustment(
          { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, indexCode: 'IPCA', period: '2026-11', oldRentAmount: 1045 },
          tenant.userId,
          transaction,
          mockAdapter(5)
        ),
      (err) => {
        assert.equal(err.code, 'RENT_ADJUSTMENT_DUPLICATE_PERIOD');
        return true;
      }
    );
  });
});

// --- Utilidades: todos os tipos contratuais (não só água/luz) + reembolso real ---

test('createUtilityObligation (banco real): aceita todos os 7 tipos do Caderno (WATER/ELECTRICITY/GAS/CONDO/IPTU/SPU/OTHER)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);

    for (const utilityType of utilitiesService.UTILITY_TYPES) {
      const { obligation } = await utilitiesService.createUtilityObligation(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, utilityType, responsibleParty: 'TENANT' },
        tenant.userId,
        transaction
      );
      assert.equal(obligation.utilityType, utilityType);
      assert.equal(obligation.status, 'ACTIVE');
    }
  });
});

test('recordUtilityPayment (banco real, tipo GAS): parte errada paga gera reembolso + FinancialEntry RECEIVABLE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    const { obligation } = await utilitiesService.createUtilityObligation(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, utilityType: 'GAS', responsibleParty: 'TENANT' },
      tenant.userId,
      transaction
    );

    const { reimbursement, financialEntry } = await utilitiesService.recordUtilityPayment(
      obligation.id,
      { amount: 180, paidByParty: 'LANDLORD' },
      tenant.userId,
      transaction
    );

    assert.ok(reimbursement);
    assert.equal(reimbursement.paidByParty, 'LANDLORD');
    assert.equal(reimbursement.owedByParty, 'TENANT');
    assert.equal(Number(reimbursement.amount), 180);
    assert.equal(reimbursement.status, 'PENDING');
    assert.ok(financialEntry);
    assert.equal(financialEntry.nature, 'RECEIVABLE');
    assert.equal(Number(financialEntry.amount), 180);
    assert.equal(reimbursement.financialEntryId, financialEntry.id, 'reembolso referencia o lançamento financeiro real, não fica só informativo');
  });
});

test('recordUtilityPayment (banco real): parte responsável paga a própria conta — nenhum reembolso/lançamento é criado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    const { obligation } = await utilitiesService.createUtilityObligation(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, utilityType: 'CONDO', responsibleParty: 'LANDLORD' },
      tenant.userId,
      transaction
    );

    const { reimbursement, financialEntry } = await utilitiesService.recordUtilityPayment(
      obligation.id,
      { amount: 400, paidByParty: 'LANDLORD' },
      tenant.userId,
      transaction
    );

    assert.equal(reimbursement, null);
    assert.equal(financialEntry, null);
  });
});

test('completeOwnershipTransfer (banco real): exige comprovante real pertencente à empresa (A05 reforçado, não só evidenceFileId truthy)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await createLeaseContract(transaction, suffix);
    const recipient = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Utilidades QA ${suffix}` },
      tenant.userId,
      transaction
    );
    const { transferTask } = await utilitiesService.createUtilityObligation(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, utilityType: 'ELECTRICITY', responsibleParty: 'TENANT', transferRequired: true },
      tenant.userId,
      transaction
    );

    // evidenceFileId aponta para um File inexistente/forjado — deve ser rejeitado mesmo sendo "truthy".
    await assert.rejects(
      () =>
        utilitiesService.completeOwnershipTransfer(
          transferTask.id,
          { evidenceFileId: '00000000-0000-0000-0000-000000000000', toPersonId: recipient.id },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'OWNERSHIP_TRANSFER_EVIDENCE_NOT_FOUND');
        return true;
      }
    );

    const realFile = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        fileName: `comprovante-transferencia-${suffix}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        storageKey: `qa/${suffix}.pdf`,
        uploadedBy: tenant.userId,
      },
      { transaction }
    );

    const completed = await utilitiesService.completeOwnershipTransfer(
      transferTask.id,
      { evidenceFileId: realFile.id, toPersonId: recipient.id },
      tenant.userId,
      transaction
    );
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.evidenceFileId, realFile.id);

    const obligation = await utilitiesService.getUtilityObligation(transferTask.utilityObligationId, transaction);
    assert.equal(obligation.status, 'TRANSFERRED');
  });
});
