'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createActiveLeaseWithInspection(transaction) {
  const suffix = uniqueSuffix();
  const property = await propertiesService.createProperty(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      propertyType: 'RESIDENTIAL',
      title: `KD QA ${suffix}`,
      internalCode: `KDQA-${suffix}`,
    },
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
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `KD QA Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  const tenantPerson = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `KD QA Locatário ${suffix}` },
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
  await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: 'kd-qa-locador' }, tenant.userId, transaction);
  await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'kd-qa-locatario' }, tenant.userId, transaction);

  return { contract, inspection, landlord, tenantPerson };
}

// Caderno Anexo I "10. Entrega de chaves": "Exigir documentos e garantias válidos."
test('releaseKeyDelivery bloqueia quando existe garantia cadastrada mas nenhuma ACTIVE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'CANCELLED' },
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
      }
    );
  });
});

test('releaseKeyDelivery libera normalmente com garantia ACTIVE válida', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE' },
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
      { keysCount: 3, keysIdentification: '2 chaves + 1 controle', termSignedByPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.keysCount, 3);
    assert.equal(released.termSignedByPersonId, tenantPerson.id);
    assert.ok(released.termSignedAt);
  });
});

// Caderno Anexo I "10. Entrega de chaves": "Registrar quantidade/identificação de
// chaves/controles", "Assinatura do termo de entrega."
test('releaseKeyDelivery exige keysCount e termSignedByPersonId (JUR-TS-004 "Chave cedo")', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { termSignedByPersonId: tenantPerson.id }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_VALIDATION');
        return true;
      },
      'sem keysCount, não pode liberar'
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 2 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_VALIDATION');
        return true;
      },
      'sem termSignedByPersonId (assinatura do termo), não pode liberar'
    );
  });
});

test('releaseKeyDelivery exige fotos quando a política marca photosRequired', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        keyDeliveriesService.releaseKeyDelivery(
          keyDelivery.id,
          { keysCount: 1, termSignedByPersonId: tenantPerson.id, photosRequired: true },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED');
        return true;
      }
    );

    const released = await keyDeliveriesService.releaseKeyDelivery(
      keyDelivery.id,
      { keysCount: 1, termSignedByPersonId: tenantPerson.id, photosRequired: true, photosFileIds: ['11111111-1111-1111-1111-111111111111'] },
      tenant.userId,
      transaction
    );
    assert.equal(released.status, 'RELEASED');
  });
});
