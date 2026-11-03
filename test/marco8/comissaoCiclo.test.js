'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const commissionsService = require('../../src/features/correspondent/cases/commissionEntitlements.service');
const reconciliationService = require('../../src/features/correspondent/fiscal/reconciliation.service');
const { Person, AuditLog, FinancialEntry, FiscalReconciliation } = require('../../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function criarCaso(transaction) {
  const pessoa = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente ciclo ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      providerCode: 'sandbox',
      applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }],
    },
    tenant.userId,
    transaction
  );
}

test('M8-COM-01: confirmar passa por CONFIRMED, vira RECEIVABLE e receber não cria outro lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await criarCaso(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 100000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await assert.rejects(
      () => commissionsService.receiveCommissionEntitlement(
        entitlement.id,
        tenant.userId,
        tenant.groupId,
        tenant.companyId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'COMMISSION_ENTITLEMENT_NOT_RECEIVABLE');
        return true;
      }
    );

    const confirmed = await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: `ext-${uniqueSuffix()}` },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(confirmed.status, 'RECEIVABLE');
    const audit = await AuditLog.findOne({
      where: { action: 'correspondent.commission_entitlement.confirm', entityId: financingCase.id },
      transaction,
    });
    assert.equal(audit.beforeJson.status, 'EXPECTED');
    assert.equal(audit.afterJson.passedThrough, 'CONFIRMED');
    assert.equal(audit.afterJson.status, 'RECEIVABLE');

    const received = await commissionsService.receiveCommissionEntitlement(
      entitlement.id,
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(received.status, 'RECEIVED');
    assert.equal(received.financialEntryId, confirmed.financialEntryId);
    const entries = await FinancialEntry.findAll({ where: { id: received.financialEntryId }, transaction });
    assert.equal(entries.length, 1);

    const again = await commissionsService.receiveCommissionEntitlement(
      entitlement.id,
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(again.status, 'RECEIVED');
  });
});

test('M8-COM-02: diferença de DIMOB com contrato abre reconciliação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceId = crypto.randomUUID();
    const opened = await reconciliationService.reconcile(
      'DIMOB_X_CONTRACTS',
      referenceId,
      1000,
      800,
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(opened.status, 'OPEN');
    assert.equal(Number(opened.differenceAmount), 200);
    const row = await FiscalReconciliation.findByPk(opened.id, { transaction });
    assert.equal(row.reconciliationType, 'DIMOB_X_CONTRACTS');

    const matched = await reconciliationService.reconcile(
      'DIMOB_X_CONTRACTS',
      crypto.randomUUID(),
      1000,
      1000,
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(matched, null);
  });
});
