'use strict';

/**
 * Fechamento do Marco 5 — Locação: entrega de chaves (Caderno M5 §10, JUR-005, JUR-TS-004, §18).
 * Camada de serviço em transação desfeita no fim (RLS do tenant de seed).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const guaranteesService = require('../src/modules/legal/leasing/guarantee.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const keyDeliveriesService = require('../src/modules/legal/leasing/key-delivery.service');
const filesService = require('../src/features/files/files.service');
const { OutboxEvent } = require('../src/models');
const { keyDeliveryReady, completeInsurance } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function upload(t, fileName, mimeType) {
  return filesService.uploadFile({ ...base(), fileName, mimeType, contentBase64: Buffer.from(`${fileName} ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);
}

async function lease(t, { propertyId, status = 'ACTIVE' } = {}) {
  const sfx = uniqueSuffix();
  const property = propertyId ? { id: propertyId } : await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F chaves ${sfx}`, internalCode: `M5FC-${sfx}` }, tenant.userId, t);
  const contract = await contractsService.createContract({ ...base(), contractType: 'LEASE', propertyId: property.id, totalValue: 2000 }, tenant.userId, t);
  contract.status = status;
  await contract.save({ transaction: t });
  const landlord = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F Locador ${sfx}` }, tenant.userId, t);
  const renter = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F Locatário ${sfx}` }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: renter.id, partyRole: 'TENANT' }, tenant.userId, t);
  const termEvidenceFileId = await keyDeliveryReady(tenant, contract.id, t);
  return { contract, property, landlord, renter, termEvidenceFileId };
}

async function signedCheckIn(t, propertyId, contractId) {
  const ins = await inspectionsService.createInspection({ ...base(), propertyId, contractId, inspectionType: 'ENTRY' }, tenant.userId, t);
  await inspectionsService.completeInspection(ins.id, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'locador' }, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 'locatário' }, tenant.userId, t);
  return ins;
}

const expectCode = (code) => (err) => { assert.equal(err.code, code, `${err.code}: ${err.message}`); return true; };

test('fechamento M5 §10: foto inventada ou arquivo que não é imagem não conta como foto obrigatória; imagem enviada libera o imóvel usado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, property, renter, termEvidenceFileId } = await lease(t);
    await signedCheckIn(t, property.id, contract.id);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id, termType: 'USED_PROPERTY_DELIVERY' }, tenant.userId, t);
    const body = { keysCount: 2, keysIdentification: '2 chaves da porta', termSignedByPersonId: renter.id, termEvidenceFileId };
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED'));
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, photosFileIds: ['11111111-1111-4111-8111-111111111111'] }, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_PHOTO_INVALID'));
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, photosFileIds: ['não-é-id'] }, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_PHOTO_INVALID'));
    const pdf = await upload(t, 'laudo.pdf', 'application/pdf');
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, photosFileIds: [pdf.id] }, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_PHOTO_INVALID'));
    const photo = await upload(t, 'sala.jpg', 'image/jpeg');
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, photosFileIds: [photo.id] }, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
    assert.deepEqual(released.photosFileIds, [photo.id]);
    assert.equal(released.photoPolicy, 'REQUIRED_USED_PROPERTY');
  });
});

test('fechamento M5 §10/JUR-005: vistoria de entrada assinada de OUTRO contrato do mesmo imóvel não libera as chaves; vistoria do imóvel sem contrato continua valendo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const previous = await lease(t);
    await signedCheckIn(t, previous.property.id, previous.contract.id);
    const current = await lease(t, { propertyId: previous.property.id });
    const { termEvidenceFileId } = current;
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: current.contract.id, deliveredToPersonId: current.renter.id }, tenant.userId, t);
    const body = { keysCount: 1, keysIdentification: 'chave da porta', termSignedByPersonId: current.renter.id, termEvidenceFileId };
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_BLOCKED'));
    await signedCheckIn(t, previous.property.id, null);
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
  });
});

test('fechamento M5 §10/JUR-TS-004: contrato fora de SIGNED/ACTIVE bloqueia a entrega mesmo com vistoria assinada e garantia válida; SIGNED libera', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, property, renter, termEvidenceFileId } = await lease(t, { status: 'APPROVED' });
    await signedCheckIn(t, property.id, contract.id);
    await guaranteesService.createGuarantee(contract.id, await completeInsurance(tenant, t), tenant.userId, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    const body = { keysCount: 2, keysIdentification: 'chave e controle', termSignedByPersonId: renter.id, termEvidenceFileId };
    for (const status of ['DRAFT', 'APPROVED', 'SIGNING', 'SUSPENDED', 'TERMINATED']) {
      contract.status = status;
      await contract.save({ transaction: t });
      await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_BLOCKED'), status);
    }
    contract.status = 'SIGNED';
    await contract.save({ transaction: t });
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
  });
});

test('fechamento M5 §10/§18: keys.delivered é publicado uma única vez, na mesma transação da liberação, e nada é publicado quando o gate bloqueia', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, property, renter, termEvidenceFileId } = await lease(t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    const body = { keysCount: 3, keysIdentification: '2 chaves e 1 controle', termSignedByPersonId: renter.id, termEvidenceFileId };
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_BLOCKED'));
    assert.equal(await OutboxEvent.count({ where: { eventType: 'keys.delivered', aggregateId: kd.id }, transaction: t }), 0);
    await signedCheckIn(t, property.id, contract.id);
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t);
    const events = await OutboxEvent.findAll({ where: { aggregateId: kd.id }, transaction: t });
    const delivered = events.filter((e) => e.eventType === 'keys.delivered');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].idempotencyKey, `keys.delivered:${kd.id}`);
    assert.equal(delivered[0].payloadJson.contractId, contract.id);
    assert.ok(events.some((e) => e.eventType === 'legal.key_delivery.released'));
    assert.equal(released.keysCount, 3);
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_ALREADY_RELEASED'));
    assert.equal(await OutboxEvent.count({ where: { eventType: 'keys.delivered', aggregateId: kd.id }, transaction: t }), 1);
  });
});

test('fechamento M5 §10: venda (casa nova) aceita a vistoria FINAL assinada; locação com só a FINAL continua bloqueada (exige a de entrada)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F casa nova ${sfx}`, internalCode: `M5FN-${sfx}` }, tenant.userId, t);
    const sale = await contractsService.createContract({ ...base(), contractType: 'SALE_CASH', propertyId: property.id, totalValue: 500000 }, tenant.userId, t);
    sale.status = 'SIGNED';
    await sale.save({ transaction: t });
    const buyer = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F Comprador ${sfx}` }, tenant.userId, t);
    await contractsService.addContractParty(sale.id, { personId: buyer.id, partyRole: 'BUYER' }, tenant.userId, t);
    const final = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: sale.id, inspectionType: 'FINAL' }, tenant.userId, t);
    await inspectionsService.completeInspection(final.id, tenant.userId, t);
    await inspectionsService.signInspection(final.id, { partyRole: 'LANDLORD', signaturePayload: 'vendedor' }, tenant.userId, t);
    await inspectionsService.signInspection(final.id, { partyRole: 'TENANT', signaturePayload: 'comprador' }, tenant.userId, t);
    const photo = await upload(t, 'fachada.png', 'image/png');
    const saleTerm = await keyDeliveryReady(tenant, sale.id, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: sale.id, deliveredToPersonId: buyer.id }, tenant.userId, t);
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 4, keysIdentification: '3 chaves e 1 controle', termSignedByPersonId: buyer.id, photosFileIds: [photo.id], termEvidenceFileId: saleTerm }, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.photoPolicy, 'REQUIRED_SALE_DELIVERY');

    const { contract, renter, termEvidenceFileId } = await lease(t, { propertyId: property.id });
    const onlyFinal = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'FINAL' }, tenant.userId, t);
    await inspectionsService.completeInspection(onlyFinal.id, tenant.userId, t);
    await inspectionsService.signInspection(onlyFinal.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    await inspectionsService.signInspection(onlyFinal.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
    const kd2 = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd2.id, { keysCount: 1, keysIdentification: 'chave', termSignedByPersonId: renter.id, termEvidenceFileId }, tenant.userId, t), expectCode('LEGAL_KEY_DELIVERY_BLOCKED'));
  });
});
