'use strict';

/**
 * Fechamento do Marco 5 — Locação, 3ª rodada (defeitos achados pela revisão do Front): PATCH do fiador grava a pessoa,
 * arquivos de garantia/termo/mídia com dono (leitura por quem tem legal:read, nunca de outra empresa), mídia listada
 * com hash e data/hora, ordem dos gates da entrega e seed do gestor de CI. Camada de serviço, transação desfeita.
 */
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const guaranteesService = require('../src/modules/legal/leasing/guarantee.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const keyDeliveriesService = require('../src/modules/legal/leasing/key-delivery.service');
const fileAccess = require('../src/features/files/fileAccess.service');
const { PROFILES } = require('../scripts/seed-ci-two-tenants');
const { Contract, Person } = require('../src/models');
const { uploadTestFile, completeGuarantor, completeInsurance, keyDeliveryReady } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };
const other = (permissions) => ({ userId: crypto.randomUUID(), groupId: tenant.groupId, companyId: tenant.companyId, permissions });

async function contract(t) {
  return Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5F3-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
}

test('fechamento M5 3ª rodada: PATCH da garantia grava a troca da pessoa fiadora', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const a = await Person.create({ ...base(), personType: 'PF', legalName: `M5F3 fiador A ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction: t });
    const b = await Person.create({ ...base(), personType: 'PF', legalName: `M5F3 fiador B ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction: t });
    const g = await guaranteesService.createGuarantee(ct.id, await completeGuarantor(tenant, t, a.id), tenant.userId, t);
    await guaranteesService.updateGuarantee(g.id, { guarantorPersonId: b.id }, tenant.userId, t);
    assert.equal((await guaranteesService.getGuarantee(g.id, t)).guarantorPersonId, b.id);
    await assert.rejects(guaranteesService.updateGuarantee(g.id, { guarantorPersonId: null }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
  });
});

test('fechamento M5 3ª rodada: arquivos da garantia, via assinada do termo e mídia da vistoria têm dono — legal:read lê, outra permissão não, outra empresa nem vê', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const fiador = await Person.create({ ...base(), personType: 'PF', legalName: `M5F3 fiador ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction: t });
    const guarantor = await completeGuarantor(tenant, t, fiador.id);
    await guaranteesService.createGuarantee(ct.id, guarantor, tenant.userId, t);
    const insurance = await completeInsurance(tenant, t);
    await guaranteesService.createGuarantee(ct.id, insurance, tenant.userId, t);
    const cert = await uploadTestFile(tenant, t, 'titulo.pdf');
    await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'CAPITALIZATION', value: 100, endsAt: '2030-01-01', providerName: 'X', certificateNumber: `C-${uniqueSuffix()}`, certificateFileId: cert.id }, tenant.userId, t);

    const sfx = uniqueSuffix();
    const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F3 ${sfx}`, internalCode: `M5F3-${sfx}` }, tenant.userId, t);
    const lease = await contractsService.createContract({ ...base(), contractType: 'LEASE', propertyId: property.id, totalValue: 1000 }, tenant.userId, t);
    lease.status = 'ACTIVE';
    await lease.save({ transaction: t });
    const renter = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F3 locatário ${sfx}` }, tenant.userId, t);
    const landlord = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F3 locador ${sfx}` }, tenant.userId, t);
    await contractsService.addContractParty(lease.id, { personId: renter.id, partyRole: 'TENANT' }, tenant.userId, t);
    await contractsService.addContractParty(lease.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: lease.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const item = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Sala — piso', condition: 'GOOD' }, tenant.userId, t);
    const foto = await uploadTestFile(tenant, t, 'sala.jpg', 'image/jpeg');
    await inspectionsService.attachInspectionItemMedia(item.id, { fileId: foto.id, mediaType: 'PHOTO' }, tenant.userId, t);
    await inspectionsService.completeInspection(ins.id, tenant.userId, t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
    const via = await keyDeliveryReady(tenant, lease.id, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: lease.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    await keyDeliveriesService.releaseKeyDelivery(kd.id, { keysCount: 1, keysIdentification: 'porta', termSignedByPersonId: renter.id, termEvidenceFileId: via }, tenant.userId, t);

    const files = [guarantor.acceptanceFileId, guarantor.documentFileIds[0], insurance.policyFileId, cert.id, via, foto.id];
    for (const id of files) {
      await assert.doesNotReject(fileAccess.assertCanReadFile(id, other(['legal:read']), t), `legal:read lê ${id}`);
      await assert.rejects(fileAccess.assertCanReadFile(id, other(['finance:read']), t), code('FILE_ACCESS_FORBIDDEN'));
    }
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: crypto.randomUUID() }, transaction: t });
    for (const id of files) await assert.rejects(fileAccess.assertCanReadFile(id, other(['legal:read']), t), code('FILE_NOT_FOUND'));
  });
});

test('fechamento M5 3ª rodada: a lista de mídias do item vem de legal.inspection_media com sha256 e data/hora (também na revisão)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F3 midia ${sfx}`, internalCode: `M5F3M-${sfx}` }, tenant.userId, t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const item = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Cozinha — pia', condition: 'GOOD' }, tenant.userId, t);
    const foto = await uploadTestFile(tenant, t, 'pia.jpg', 'image/jpeg');
    await inspectionsService.attachInspectionItemMedia(item.id, { fileId: foto.id, mediaType: 'PHOTO' }, tenant.userId, t);
    const [m] = await inspectionsService.listInspectionItemMedia(item.id, t);
    assert.deepEqual([m.fileId, m.sha256, m.mediaType, m.itemId, m.inspectionId], [foto.id, foto.checksumSha256, 'PHOTO', item.id, ins.id]);
    assert.ok(m.capturedAt instanceof Date && m.inspectionMediaId);
    await inspectionsService.completeInspection(ins.id, tenant.userId, t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    const rev = await inspectionsService.createInspectionRevision(ins.id, { reason: 'Correção' }, tenant.userId, t);
    const [revItem] = await inspectionsService.listInspectionItems(rev.id, t);
    const revMedia = await inspectionsService.listInspectionItemMedia(revItem.id, t);
    assert.deepEqual(revMedia.map((x) => [x.fileId, x.sha256]), [[foto.id, foto.checksumSha256]]);
  });
});

test('fechamento M5 3ª rodada: a entrega confere os dados do pedido e a via assinada do termo antes da assinatura da vistoria', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F3 ordem ${sfx}`, internalCode: `M5F3O-${sfx}` }, tenant.userId, t);
    const lease = await contractsService.createContract({ ...base(), contractType: 'LEASE', propertyId: property.id, totalValue: 1000 }, tenant.userId, t);
    lease.status = 'SIGNED';
    await lease.save({ transaction: t });
    const renter = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5F3 locatário ${sfx}` }, tenant.userId, t);
    await contractsService.addContractParty(lease.id, { personId: renter.id, partyRole: 'TENANT' }, tenant.userId, t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: lease.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    await inspectionsService.completeInspection(ins.id, tenant.userId, t); // concluída, ainda sem assinatura
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: lease.id, deliveredToPersonId: renter.id }, tenant.userId, t);
    const body = { keysCount: 1, keysIdentification: 'porta', termSignedByPersonId: renter.id };
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), code('LEGAL_KEY_DELIVERY_TERM_EVIDENCE_REQUIRED'));
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, { termSignedByPersonId: renter.id }, tenant.userId, t), code('LEGAL_KEY_DELIVERY_VALIDATION'));
    const via = await uploadTestFile(tenant, t);
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, { ...body, termEvidenceFileId: via.id }, tenant.userId, t), code('LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED'));
  });
});

test('fechamento M5 3ª rodada: seed de CI — o gestor lê usuários (telas de responsável) sem ganhar nenhuma permissão de ação', () => {
  const gestor = PROFILES.find((p) => p.key === 'gestor');
  assert.ok(gestor.permissions.includes('users:read'));
  assert.ok(!gestor.permissions.some((p) => /^users:(create|update|delete)$/.test(p)));
  for (const key of ['maker', 'checker', 'leitura']) assert.ok(!PROFILES.find((p) => p.key === key).permissions.includes('users:read'), `${key} continua sem users:read`);
});
