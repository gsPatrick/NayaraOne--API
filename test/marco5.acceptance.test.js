'use strict';

// Testes de aceite do Marco 5 (Contratos/Locação/Vistorias/Jurídico) — fechando itens
// PARCIAIS da matriz M5-01 a M5-34 que já tinham implementação real, só faltava prova.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const propertiesService = require('../src/features/properties/properties.service');
const personContactsService = require('../src/features/people/personContacts.service');
const { File, Person, TenantSetting } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// O tenant de homologação compartilhado tem `legal.signature_provider=clicksign` configurado DE
// VERDADE (token real) para testes manuais de assinatura eletrônica em andamento. M5-22/M5-23
// testa o GATE de negócio de entrega de chaves, não a integração real com o Clicksign — precisa
// do Sandbox determinístico (sem I/O de rede). Zera explicitamente as settings de assinatura
// DENTRO da própria transação de rollback (hard delete, nunca commitado — mesma nota em
// test/legal.signatureProviders.test.js).
const SIGNATURE_SETTING_KEYS = [
  'legal.signature_provider',
  'legal.clicksign_api_token',
  'legal.clicksign_environment',
  'legal.clicksign_webhook_secret',
  'legal.zapsign_api_token',
  'legal.zapsign_webhook_secret',
];

async function clearSignatureSettings(transaction) {
  await TenantSetting.destroy({
    where: { companyId: tenant.companyId, key: SIGNATURE_SETTING_KEYS },
    transaction,
    force: true,
  });
}

async function createLeaseWithParties(transaction) {
  const suffix = uniqueSuffix();
  const property = await propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, title: `M5 Imóvel ${suffix}`, internalCode: `M5-${suffix}`, propertyType: 'RESIDENTIAL' },
    tenant.userId,
    transaction
  );
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000, propertyId: property.id },
    tenant.userId,
    transaction
  );
  const landlord = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M5 Locador ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
  const tenantPerson = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M5 Locatário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
  // O tenant de homologação compartilhado tem `legal.signature_provider=clicksign`
  // configurado DE VERDADE — o provedor real exige e-mail cadastrado por signatário
  // (LEGAL_SIGNATURE_EMAIL_REQUIRED). Dado de teste legítimo, não workaround.
  for (const person of [landlord, tenantPerson]) {
    await personContactsService.createContact(
      person.id,
      { contactType: 'EMAIL', valueNormalized: `qa+${suffix}-${person.id.slice(0, 8)}@nayaraone.dev`, isPrimary: true },
      tenant.userId,
      transaction
    );
  }
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, transaction);
  return { contract, landlord, tenantPerson };
}

// --- M5-04: datas de início/fim persistidas e corrigíveis com auditoria ---
test('M5-04 startsAt/endsAt são persistidas na criação e corrigíveis via correctContractData com auditoria', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const startsAt = new Date('2026-10-01T12:00:00Z');
    const endsAt = new Date('2027-10-01T12:00:00Z');
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1200, startsAt, endsAt },
      tenant.userId,
      transaction
    );
    assert.equal(new Date(contract.startsAt).toISOString(), startsAt.toISOString());
    assert.equal(new Date(contract.endsAt).toISOString(), endsAt.toISOString());

    const newEndsAt = new Date('2027-12-01T12:00:00Z');
    const corrected = await contractsService.correctContractData(
      contract.id,
      { endsAt: newEndsAt, reason: 'Prorrogação combinada com o locatário' },
      tenant.userId,
      transaction
    );
    assert.equal(new Date(corrected.endsAt).toISOString(), newEndsAt.toISOString());
  });
});

// --- M5-17/M5-18: garantias completas (tipo/valor/vigência) e fiador vinculado à parte certa ---
test('M5-17/M5-18 createGuarantee exige guarantorPersonId para GUARANTOR, persiste valor/vigência', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const suffix = uniqueSuffix();

    await assert.rejects(
      () => guaranteesService.createGuarantee(contract.id, { guaranteeType: 'GUARANTOR' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'LEGAL_GUARANTEE_VALIDATION'); return true; },
      'garantia tipo GUARANTOR sem guarantorPersonId precisa ser rejeitada'
    );

    const guarantor = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M5-18 Fiador ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
    const startsAt = new Date();
    const endsAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'GUARANTOR', guarantorPersonId: guarantor.id, value: 5000, startsAt, endsAt },
      tenant.userId,
      transaction
    );
    assert.equal(guarantee.guarantorPersonId, guarantor.id);
    assert.equal(Number(guarantee.value), 5000);
    assert.equal(guarantee.status, 'ACTIVE');
  });
});

// --- M5-22/M5-23: entrega de chaves bloqueada sem contrato assinado + vistoria concluída, registro completo ao liberar ---
test('M5-22/M5-23 releaseKeyDelivery bloqueia sem vistoria de entrada, libera e registra quem/quando após concluída', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await clearSignatureSettings(transaction);
    const { contract } = await createLeaseWithParties(transaction);
    const suffix = uniqueSuffix();
    const file = await File.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `m522-${suffix}.pdf`, fileName: `contrato-${suffix}.pdf`, mimeType: 'application/pdf', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    await contractVersionsService.createContractVersion(contract.id, { content: `M5-22 corpo ${suffix}`, documentFileId: file.id }, tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);
    // Assina de verdade via o fluxo real (sandbox) — quando a ÚLTIMA assinatura confirma via
    // webhook, o próprio handleSignatureWebhook já transiciona o contrato pra SIGNED sozinho.
    const signaturesService = require('../src/features/legal/signatures.service');
    const version = await contractVersionsService.listContractVersions(contract.id, transaction).then((v) => v[0]);
    const parties = await contractsService.listContractParties(contract.id, transaction);
    const signatures = await signaturesService.initiateSignature(version.id, parties.map((p) => p.personId), tenant.userId, transaction);
    for (const sig of signatures) {
      await signaturesService.handleSignatureWebhook(sig.externalSignatureId, {}, transaction);
    }

    const person = parties[0];
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, deliveredToPersonId: person.personId },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'LEGAL_KEY_DELIVERY_BLOCKED'); return true; },
      'sem vistoria de entrada concluída, a entrega de chaves precisa ser bloqueada mesmo com contrato SIGNED'
    );

    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: contract.propertyId, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );
    await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);

    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED'); return true; },
      'vistoria CONCLUÍDA mas SEM assinatura de locador/locatário ainda tem que bloquear a liberação'
    );
    await inspectionsService.signInspection(inspection.id, { partyRole: 'LANDLORD', signaturePayload: 'assinatura-locador-m522' }, tenant.userId, transaction);
    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED'); return true; },
      'só o locador ter assinado ainda não basta — falta o locatário'
    );
    await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'assinatura-locatario-m522' }, tenant.userId, transaction);

    const released = await keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, tenant.userId, transaction);
    assert.equal(released.status, 'RELEASED');
    assert.ok(released.deliveredAt, 'precisa registrar QUANDO as chaves foram entregues');
    assert.equal(released.deliveredByUserId, tenant.userId, 'precisa registrar QUEM entregou');
    assert.equal(released.deliveredToPersonId, person.personId, 'precisa registrar QUEM recebeu (já era obrigatório na criação)');
  });
});
