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
// ACHADO REAL (auditoria técnica independente da Nayara, A04): o job que marca garantia vencida
// como EXPIRED roda periodicamente — entre o vencimento real (endsAt no passado) e o job rodar,
// o status no banco ainda podia estar ACTIVE, liberando a chave indevidamente. Reproduz
// exatamente o cenário do achado: startsAt=2019-01-01, endsAt=2020-01-01, status ainda ACTIVE.
test('releaseKeyDelivery bloqueia garantia com endsAt vencido mesmo com status ainda ACTIVE (A04)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500, status: 'ACTIVE', startsAt: '2019-01-01', endsAt: '2020-01-01' },
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

    // GAP REAL (verificação cética Marco 5, ciclo 4): o model KeyDelivery nunca declarava
    // keysCount/keysIdentification/photosFileIds/termType/termSignedByPersonId/termSignedAt —
    // a atribuição na instância passava na asserção acima mesmo sem persistir nada de verdade
    // (Sequelize só grava atributo declarado). Reler do banco é o que de fato prova o fix.
    const reloaded = await keyDeliveriesService.getKeyDelivery(keyDelivery.id, transaction);
    assert.equal(reloaded.keysCount, 3);
    assert.equal(reloaded.keysIdentification, '2 chaves + 1 controle');
    assert.equal(reloaded.termSignedByPersonId, tenantPerson.id);
    assert.ok(reloaded.termSignedAt);
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

// Frente 5: a política de fotos é do SERVIDOR (imóvel usado exige fotos); o cliente não manda
// mais "photosRequired" — se mandar, 400 LEGAL_KEY_DELIVERY_SERVER_POLICY.
test('releaseKeyDelivery exige fotos quando a política do servidor exige (imóvel usado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, inspection, tenantPerson } = await createActiveLeaseWithInspection(transaction);
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, inspectionId: inspection.id, deliveredToPersonId: tenantPerson.id, termType: 'USED_PROPERTY_DELIVERY' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, { keysCount: 1, termSignedByPersonId: tenantPerson.id, photosRequired: false }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_SERVER_POLICY');
        return true;
      }
    );

    await assert.rejects(
      () =>
        keyDeliveriesService.releaseKeyDelivery(
          keyDelivery.id,
          { keysCount: 1, termSignedByPersonId: tenantPerson.id },
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
      { keysCount: 1, termSignedByPersonId: tenantPerson.id, photosFileIds: ['11111111-1111-1111-1111-111111111111'] },
      tenant.userId,
      transaction
    );
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.photosRequired, true);
    assert.equal(released.photoPolicy, 'REQUIRED_USED_PROPERTY');
  });
});
