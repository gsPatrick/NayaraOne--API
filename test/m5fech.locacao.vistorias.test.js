'use strict';

/**
 * Fechamento do Marco 5 — Locação: vistorias (Caderno M5 §11, §18, Guia §10). Camada de serviço em
 * transação desfeita no fim (RLS do tenant de seed).
 */
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const filesService = require('../src/features/files/files.service');
const { OutboxEvent, FinancialEntry, File } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function setup(t) {
  const sfx = uniqueSuffix();
  const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F vistoria ${sfx}`, internalCode: `M5FV-${sfx}` }, tenant.userId, t);
  const contract = await contractsService.createContract({ ...base(), contractType: 'LEASE', propertyId: property.id, totalValue: 2000 }, tenant.userId, t);
  return { property, contract };
}

async function media(t, itemId, mediaType, content) {
  const file = await filesService.uploadFile({ ...base(), fileName: mediaType === 'VIDEO' ? 'video.mp4' : 'foto.jpg', mimeType: mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg', contentBase64: Buffer.from(content).toString('base64'), category: 'generic' }, tenant.userId, t);
  const link = await inspectionsService.attachInspectionItemMedia(itemId, { fileId: file.id, mediaType }, tenant.userId, t);
  return { file, link };
}

test('fechamento M5 §11: foto e vídeo do item têm hash SHA-256 do conteúdo, data/hora e vínculo ao item', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { property, contract } = await setup(t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const item = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Sala — piso', condition: 'GOOD' }, tenant.userId, t);
    const content = `foto do piso ${uniqueSuffix()}`;
    const photo = await media(t, item.id, 'PHOTO', content);
    const video = await media(t, item.id, 'VIDEO', `vídeo ${uniqueSuffix()}`);
    const stored = await File.findByPk(photo.file.id, { transaction: t });
    assert.equal(stored.checksumSha256, crypto.createHash('sha256').update(Buffer.from(content)).digest('hex'));
    assert.ok(stored.created_at || stored.createdAt, 'arquivo com data/hora de envio');
    const links = await inspectionsService.listInspectionItemMedia(item.id, t);
    assert.deepEqual(links.map((l) => l.purpose).sort(), ['PHOTO', 'VIDEO']);
    for (const l of links) {
      assert.equal(l.relatedEntityType, 'InspectionItem');
      assert.equal(l.relatedEntityId, item.id);
      assert.ok(l.created_at || l.createdAt, 'vínculo com data/hora');
    }
    assert.ok([photo.link.fileId, video.link.fileId].every((id) => links.some((l) => l.fileId === id)));
  });
});

test('fechamento M5 Guia §10: comparação entrada x saída traz before/after/changed/mediaRefs por item, não cria cobrança e exige validação humana', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { property, contract } = await setup(t);
    const entry = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const exit = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'EXIT' }, tenant.userId, t);
    const eSala = await inspectionsService.addInspectionItem(entry.id, { itemName: 'Sala — piso', condition: 'GOOD' }, tenant.userId, t);
    await inspectionsService.addInspectionItem(entry.id, { itemName: 'Cozinha — pia', condition: 'REGULAR' }, tenant.userId, t);
    await inspectionsService.addInspectionItem(entry.id, { itemName: 'Quarto — porta', condition: 'GOOD' }, tenant.userId, t);
    const sSala = await inspectionsService.addInspectionItem(exit.id, { itemName: 'Sala — piso', condition: 'DAMAGED', damageDescription: 'Riscos', estimatedBudget: 500, responsibleParty: 'UNDETERMINED' }, tenant.userId, t);
    await inspectionsService.addInspectionItem(exit.id, { itemName: 'Cozinha — pia', condition: 'REGULAR' }, tenant.userId, t);
    const before1 = await media(t, eSala.id, 'PHOTO', `antes ${uniqueSuffix()}`);
    const after1 = await media(t, sSala.id, 'PHOTO', `depois ${uniqueSuffix()}`);

    const result = await inspectionsService.compareInspections(entry.id, exit.id, t);
    assert.equal(result.requiresHumanValidation, true);
    const byName = Object.fromEntries(result.items.map((i) => [i.itemName, i]));
    assert.deepEqual(
      { before: byName['Sala — piso'].before, after: byName['Sala — piso'].after, changed: byName['Sala — piso'].changed },
      { before: 'GOOD', after: 'DAMAGED', changed: true }
    );
    assert.deepEqual(byName['Sala — piso'].mediaRefs, [before1.file.id, after1.file.id]);
    assert.equal(byName['Cozinha — pia'].changed, false);
    assert.deepEqual(byName['Cozinha — pia'].mediaRefs, []);
    assert.equal(byName['Quarto — porta'].after, null);
    assert.equal(byName['Quarto — porta'].changed, true);
    assert.ok(result.items.every((i) => i.requiresHumanValidation === true));
    assert.equal(result.divergences.length, 2);
    assert.equal(await FinancialEntry.count({ where: { contractId: contract.id }, transaction: t }), 0, 'a comparação não lança cobrança');
  });
});

test('fechamento M5 §18: inspection.signed é publicado uma vez por parte que assina, com o hash da assinatura', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { property, contract } = await setup(t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    await inspectionsService.completeInspection(ins.id, tenant.userId, t);
    const s1 = await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'locador' }, tenant.userId, t);
    const s2 = await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 'locatário' }, tenant.userId, t);
    await assert.rejects(inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 'de novo' }, tenant.userId, t), (err) => err.code === 'LEGAL_INSPECTION_ALREADY_SIGNED');
    const events = await OutboxEvent.findAll({ where: { eventType: 'inspection.signed', aggregateId: ins.id }, transaction: t });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.payloadJson.partyRole).sort(), ['LANDLORD', 'TENANT']);
    assert.deepEqual(events.map((e) => e.payloadJson.signatureHash).sort(), [s1.signatureHash, s2.signatureHash].sort());
  });
});
