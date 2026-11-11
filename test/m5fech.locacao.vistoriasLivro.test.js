'use strict';

/**
 * Fechamento do Marco 5 — Locação, segunda onda: vistorias com os códigos e a estrutura do livro (Caderno §4 e §11,
 * Guia §9/§10): tipos ENTRY/EXIT/INTERMEDIATE/FINAL gravados, ambiente/código do item, condição NEW, mídia em
 * legal.inspection_media, hash canônico do snapshot na assinatura e comparação por ambiente + item.
 */
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const { buildInspectionSnapshot, canonicalJson } = require('../src/modules/legal/inspections/inspectionSnapshot');
const { InspectionMedia, Inspection } = require('../src/models');
const { uploadTestFile } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };

async function property(t) {
  const sfx = uniqueSuffix();
  return propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F vistoria livro ${sfx}`, internalCode: `M5FVL-${sfx}` }, tenant.userId, t);
}

test('fechamento M5 §11: tipos ENTRY/EXIT/INTERMEDIATE/FINAL gravados e devolvidos com o código do livro; códigos antigos entram como apelido e o banco traduz gravador legado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const got = [];
    for (const type of ['ENTRY', 'EXIT', 'INTERMEDIATE', 'FINAL', 'CHECK_IN', 'CHECK_OUT', 'PERIODIC']) {
      got.push((await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: type }, tenant.userId, t)).inspectionType);
    }
    assert.deepEqual(got, ['ENTRY', 'EXIT', 'INTERMEDIATE', 'FINAL', 'ENTRY', 'EXIT', 'INTERMEDIATE']);
    const legacy = await Inspection.create({ ...base(), propertyId: p.id, inspectionType: 'CHECK_IN', status: 'SCHEDULED' }, { transaction: t });
    const [[row]] = await sequelize.query('SELECT inspection_type FROM legal.inspections WHERE id = :id', { replacements: { id: legacy.id }, transaction: t });
    assert.equal(row.inspection_type, 'ENTRY');
    assert.equal((await inspectionsService.listInspections(t, { propertyId: p.id, inspectionType: 'CHECK_IN' })).length, 3, 'filtro pelo apelido acha as de entrada');
    await assert.rejects(inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'SURPRESA' }, tenant.userId, t), code('LEGAL_INSPECTION_VALIDATION'));
  });
});

test('fechamento M5 §11/Guia §9: item tem ambiente (roomCode), código (itemCode), estado NEW|GOOD|REGULAR|DAMAGED, descrição, observação e responsabilidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const novo = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Pintura', roomCode: 'quarto_1', itemCode: 'PAREDES', condition: 'NEW', description: 'Pintura recém-feita', notes: 'Cor branco gelo', responsibleParty: 'LANDLORD' }, tenant.userId, t);
    assert.deepEqual([novo.roomCode, novo.itemCode, novo.condition, novo.description, novo.notes, novo.responsibleParty], ['QUARTO_1', 'PAREDES', 'NEW', 'Pintura recém-feita', 'Cor branco gelo', 'LANDLORD']);
    const derivado = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Sala — piso laminado', condition: 'GOOD' }, tenant.userId, t);
    assert.deepEqual([derivado.roomCode, derivado.itemCode], ['SALA', 'PISO_LAMINADO'], 'sem código, o servidor deriva de "Ambiente — item"');
    const solto = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Interfone', condition: 'GOOD' }, tenant.userId, t);
    assert.equal(solto.roomCode, 'GERAL', 'sem ambiente, o padrão configurado legal.inspection_default_room_code (GERAL)');
    await assert.rejects(inspectionsService.addInspectionItem(ins.id, { itemName: 'X', roomCode: 'sala de estar!', condition: 'GOOD' }, tenant.userId, t), code('LEGAL_INSPECTION_ITEM_VALIDATION'));
    await assert.rejects(inspectionsService.addInspectionItem(ins.id, { itemName: 'X', condition: 'OTIMO' }, tenant.userId, t), code('LEGAL_INSPECTION_ITEM_VALIDATION'));
  });
});

test('fechamento M5 §4/§11: mídia vai para legal.inspection_media com o SHA-256 do arquivo, data/hora e vínculo ao item; a revisão leva as mesmas mídias', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const item = await inspectionsService.addInspectionItem(ins.id, { itemName: 'Cozinha — pia', condition: 'GOOD' }, tenant.userId, t);
    const file = await uploadTestFile(tenant, t, 'pia.jpg', 'image/jpeg');
    const link = await inspectionsService.attachInspectionItemMedia(item.id, { fileId: file.id, mediaType: 'PHOTO' }, tenant.userId, t);
    const media = await InspectionMedia.findAll({ where: { inspectionId: ins.id }, transaction: t });
    assert.equal(media.length, 1);
    assert.deepEqual([media[0].itemId, media[0].fileId, media[0].sha256, media[0].mediaType, media[0].fileLinkId], [item.id, file.id, file.checksumSha256, 'PHOTO', link.id]);
    assert.ok(media[0].capturedAt instanceof Date);
    await inspectionsService.completeInspection(ins.id, tenant.userId, t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    const rev = await inspectionsService.createInspectionRevision(ins.id, { reason: 'Correção do laudo' }, tenant.userId, t);
    const revMedia = await InspectionMedia.findAll({ where: { inspectionId: rev.id }, transaction: t });
    assert.deepEqual(revMedia.map((m) => [m.fileId, m.sha256]), [[file.id, file.checksumSha256]]);
  });
});

test('fechamento M5 Guia §9: a assinatura guarda o hash do JSON canônico do conteúdo (snapshot) e todas as partes assinam o mesmo conteúdo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const ins = await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    await inspectionsService.addInspectionItem(ins.id, { itemName: 'Sala — piso', condition: 'GOOD', notes: 'ok' }, tenant.userId, t);
    await inspectionsService.completeInspection(ins.id, tenant.userId, t);
    const loaded = await inspectionsService.getInspection(ins.id, t);
    const expected = crypto.createHash('sha256').update(canonicalJson(await buildInspectionSnapshot(loaded, t))).digest('hex');
    const s1 = await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    const s2 = await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
    assert.equal(s1.snapshotHash, expected);
    assert.equal(s2.snapshotHash, expected);
    assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
    await sequelize.query("UPDATE legal.inspection_items SET notes = 'alterado por fora' WHERE inspection_id = :id", { replacements: { id: ins.id }, transaction: t });
    await assert.rejects(inspectionsService.signInspection(ins.id, { partyRole: 'INSPECTOR', signaturePayload: 'v' }, tenant.userId, t), code('LEGAL_INSPECTION_SNAPSHOT_CHANGED'));
  });
});

test('fechamento M5 Guia §10: comparação entrada x saída pareia por ambiente + código do item e devolve roomCode/itemCode', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await property(t);
    const entry = await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'ENTRY' }, tenant.userId, t);
    const exit = await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'EXIT' }, tenant.userId, t);
    await inspectionsService.addInspectionItem(entry.id, { itemName: 'Piso', roomCode: 'SALA', itemCode: 'PISO', condition: 'NEW' }, tenant.userId, t);
    await inspectionsService.addInspectionItem(exit.id, { itemName: 'Piso da sala (nome digitado diferente)', roomCode: 'SALA', itemCode: 'PISO', condition: 'DAMAGED', damageDescription: 'Riscos', estimatedBudget: 400, responsibleParty: 'TENANT' }, tenant.userId, t);
    const result = await inspectionsService.compareInspections(entry.id, exit.id, t);
    assert.equal(result.items.length, 1, 'pareados pelo código, mesmo com nomes diferentes');
    assert.deepEqual(
      { roomCode: result.items[0].roomCode, itemCode: result.items[0].itemCode, before: result.items[0].before, after: result.items[0].after, changed: result.items[0].changed },
      { roomCode: 'SALA', itemCode: 'PISO', before: 'NEW', after: 'DAMAGED', changed: true }
    );
    assert.deepEqual([result.divergences[0].roomCode, result.divergences[0].itemCode, result.divergences[0].reason], ['SALA', 'PISO', 'CONDITION_CHANGED']);
  });
});
