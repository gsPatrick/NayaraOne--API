'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — entrega de chaves, livro §10:
 *  - M5-A0079 "Checklist calculado por Motor de Regras": a política tem item da etapa KEY_DELIVERY, que só bloqueia a entrega;
 *    empresa no padrão antigo recebe o padrão novo; contrato com checklist antigo ganha o item na entrega; o checklist do termo
 *    de entrega vinculado (casa nova / imóvel usado, §7) também precisa estar completo.
 *  - M5-A0082 "Exigir documentos e garantias válidos": arquivo anexado à exigência de garantia não substitui garantia ACTIVE.
 *  - M5-A0083 "Registrar quantidade/identificação de chaves/controles": identificação obrigatória.
 *  - M5-A0084 "Fotos obrigatórias quando política exigir": política por tipo de contrato, com quantidade mínima, configurável.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const guaranteesService = require('../src/modules/legal/leasing/guarantee.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const keyDeliveriesService = require('../src/modules/legal/leasing/key-delivery.service');
const requirementsService = require('../src/modules/legal/contracts/application/requirement.service');
const requirementRules = require('../src/modules/legal/contracts/application/requirementRules.service');
const { DEFAULT_ACTION } = require('../src/modules/legal/contracts/application/requirementRules.defaults');
const filesService = require('../src/features/files/files.service');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { ContractRequirement, RuleVersion, Rule } = require('../src/models');
const { completeInsurance, uploadTestFile } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };
const image = (t, name) => filesService.uploadFile({ ...base(), fileName: name, mimeType: 'image/png', contentBase64: Buffer.from(`${name} ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);

/** Locação ACTIVE com partes, vistoria de entrada assinada e checklist gerado (NADA dispensado). */
async function leaseReady(t, contractType = 'LEASE_RESIDENTIAL') {
  const sfx = uniqueSuffix();
  const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5VP chaves ${sfx}`, internalCode: `M5VP-K-${sfx}` }, tenant.userId, t);
  const contract = await contractsService.createContract({ ...base(), contractType, propertyId: property.id, totalValue: 2000 }, tenant.userId, t);
  const landlord = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5VP Locador ${sfx}` }, tenant.userId, t);
  const renter = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5VP Locatário ${sfx}` }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: renter.id, partyRole: 'TENANT' }, tenant.userId, t);
  contract.status = 'ACTIVE';
  await contract.save({ transaction: t });
  const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'ENTRY' }, tenant.userId, t);
  await inspectionsService.completeInspection(ins.id, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
  await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
  const term = await uploadTestFile(tenant, t);
  return { contract, property, landlord, renter, termEvidenceFileId: term.id };
}

async function satisfy(t, contractId, filter) {
  const items = await requirementsService.listRequirements(contractId, t);
  for (const item of items.filter(filter)) {
    const file = await uploadTestFile(tenant, t, `${item.requirementCode}.pdf`);
    await requirementsService.satisfyRequirement(item.id, { satisfiedByFileId: file.id }, tenant.userId, t);
  }
}

async function waive(t, contractId, filter) {
  const items = await requirementsService.listRequirements(contractId, t);
  for (const item of items.filter(filter)) await requirementsService.satisfyRequirement(item.id, { waivedReason: 'Dispensa registrada no teste' }, tenant.userId, t);
}

const releaseBody = (fx, extra = {}) => ({ keysCount: 2, keysIdentification: '2 chaves da porta', termSignedByPersonId: fx.renter.id, termEvidenceFileId: fx.termEvidenceFileId, ...extra });
const newDelivery = (t, fx) => keyDeliveriesService.createKeyDelivery({ ...base(), contractId: fx.contract.id, deliveredToPersonId: fx.renter.id }, tenant.userId, t);

test('M5-A0079/§10: item da etapa KEY_DELIVERY do Motor de Regras — não trava a ativação, trava a entrega até ser cumprido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fx = await leaseReady(t);
    const items = await requirementsService.listRequirements(fx.contract.id, t);
    const keysItem = items.find((i) => i.requirementCode === 'LEASE_KEYS_LIST');
    assert.ok(keysItem, 'a política da empresa traz o item da entrega');
    assert.equal(keysItem.requiredStage, 'KEY_DELIVERY');
    await satisfy(t, fx.contract.id, (i) => i.requiredStage !== 'KEY_DELIVERY');
    assert.equal(await requirementsService.assertRequirementsSatisfied(fx.contract.id, 'ACTIVATION', t), true, 'as etapas anteriores não esperam o item da entrega');
    await guaranteesService.createGuarantee(fx.contract.id, await completeInsurance(tenant, t), tenant.userId, t);

    const kd = await newDelivery(t, fx);
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx), tenant.userId, t), (err) => {
      assert.equal(err.code, 'LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING');
      assert.deepEqual(err.details.missingRequirementCodes, ['LEASE_KEYS_LIST']);
      return true;
    });
    await satisfy(t, fx.contract.id, (i) => i.requirementCode === 'LEASE_KEYS_LIST');
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx), tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
  });
});

test('M5-A0079: empresa no padrão antigo do checklist passa ao padrão novo (versão nova, auditada) e contrato com checklist antigo ganha o item na entrega', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // Reproduz a política padrão anterior (sem o item da entrega) como a vigente da empresa.
    const old = JSON.parse(JSON.stringify(DEFAULT_ACTION));
    old.templates.LEASE = old.templates.LEASE.filter((i) => i.requirementCode !== 'LEASE_KEYS_LIST');
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(old)).digest('hex'), 'a222325e003107eeaa8a5e1f04a6319fbdcdcad34614e71645daa5f7ab90e683');
    const oldVersion = await requirementRules.publishRequirementRules(base(), old, tenant.userId, t);
    const fx = await leaseReady(t); // o checklist é gerado já pela política resolvida (padrão novo)
    const rule = await Rule.findOne({ where: { code: 'REG-JUR-001', ...base() }, transaction: t });
    const vigente = await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction: t });
    assert.ok(vigente.versionNumber > oldVersion.versionNumber, 'versão nova publicada');
    assert.ok(JSON.stringify(vigente.actionJson).includes('LEASE_KEYS_LIST'));

    // Contrato cujo checklist foi gerado no padrão antigo: o item da entrega entra na hora de entregar.
    await ContractRequirement.destroy({ where: { contractId: fx.contract.id, requirementCode: 'LEASE_KEYS_LIST' }, force: true, transaction: t });
    await waive(t, fx.contract.id, () => true);
    await guaranteesService.createGuarantee(fx.contract.id, await completeInsurance(tenant, t), tenant.userId, t);
    const kd = await newDelivery(t, fx);
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx), tenant.userId, t), code('LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING'));
    assert.ok(await ContractRequirement.findOne({ where: { contractId: fx.contract.id, requirementCode: 'LEASE_KEYS_LIST', status: 'PENDING' }, transaction: t }));

    // Política personalizada pela empresa nunca é trocada.
    const custom = JSON.parse(JSON.stringify(old));
    custom.templates.LEASE[0].description = 'Documentos das partes (texto da empresa).';
    const customVersion = await requirementRules.publishRequirementRules(base(), custom, tenant.userId, t);
    const resolved = await requirementRules.resolveRequirementPolicy(base(), tenant.userId, t);
    assert.equal(resolved.ruleVersionId, customVersion.id);
  });
});

test('M5-A0079/§7: o checklist do termo de entrega vinculado (casa nova) precisa estar completo para entregar as chaves da venda', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5VP casa nova ${sfx}`, internalCode: `M5VP-N-${sfx}` }, tenant.userId, t);
    const sale = await contractsService.createContract({ ...base(), contractType: 'SALE_CASH', propertyId: property.id, totalValue: 500000 }, tenant.userId, t);
    const buyer = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5VP Comprador ${sfx}` }, tenant.userId, t);
    await contractsService.addContractParty(sale.id, { personId: buyer.id, partyRole: 'BUYER' }, tenant.userId, t);
    sale.status = 'SIGNED';
    await sale.save({ transaction: t });
    const final = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: sale.id, inspectionType: 'FINAL' }, tenant.userId, t);
    await inspectionsService.completeInspection(final.id, tenant.userId, t);
    await inspectionsService.signInspection(final.id, { partyRole: 'LANDLORD', signaturePayload: 'v' }, tenant.userId, t);
    await inspectionsService.signInspection(final.id, { partyRole: 'TENANT', signaturePayload: 'c' }, tenant.userId, t);
    await requirementsService.generateRequirementsForContract(sale.id, {}, tenant.userId, t);
    await waive(t, sale.id, () => true);
    const termContract = await contractsService.createContract({ ...base(), contractType: 'KEY_DELIVERY', parentContractId: sale.id, propertyId: property.id }, tenant.userId, t);
    await requirementsService.generateRequirementsForContract(termContract.id, {}, tenant.userId, t);
    const termItems = (await requirementsService.listRequirements(termContract.id, t)).map((i) => i.requirementCode).sort();
    assert.deepEqual(termItems, ['NEW_DELIVERY_TERM', 'NEW_FINAL_INSPECTION', 'NEW_KEYS', 'NEW_OWNER_MANUAL', 'NEW_PHOTOS']);

    const photo = await image(t, 'fachada.png');
    const via = await uploadTestFile(tenant, t);
    const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: sale.id, deliveredToPersonId: buyer.id }, tenant.userId, t);
    const body = { keysCount: 3, keysIdentification: '2 chaves e 1 controle', termSignedByPersonId: buyer.id, photosFileIds: [photo.id], termEvidenceFileId: via.id };
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), (err) => {
      assert.equal(err.code, 'LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING');
      assert.ok(err.details.missingRequirementCodes.includes('NEW_OWNER_MANUAL'), 'manual do proprietário cobrado');
      return true;
    });
    await satisfy(t, termContract.id, () => true);
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
  });
});

test('M5-A0082/§10: exigência de garantia satisfeita só com arquivo não libera as chaves; garantia ACTIVE vigente libera; dispensa formal também', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fx = await leaseReady(t);
    await satisfy(t, fx.contract.id, () => true); // inclusive LEASE_GUARANTEE, com um arquivo qualquer
    const kd = await newDelivery(t, fx);
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx), tenant.userId, t), code('LEGAL_KEY_DELIVERY_GUARANTEE_REQUIRED'));
    await guaranteesService.createGuarantee(fx.contract.id, await completeInsurance(tenant, t), tenant.userId, t);
    assert.equal((await keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx), tenant.userId, t)).status, 'RELEASED');

    const waived = await leaseReady(t);
    await satisfy(t, waived.contract.id, (i) => i.requirementType !== 'GUARANTEE');
    await waive(t, waived.contract.id, (i) => i.requirementType === 'GUARANTEE');
    const kd2 = await newDelivery(t, waived);
    assert.equal((await keyDeliveriesService.releaseKeyDelivery(kd2.id, releaseBody(waived), tenant.userId, t)).status, 'RELEASED', 'locação sem garantia só com dispensa registrada');
  });
});

test('M5-A0083/§10: identificação das chaves/controles é obrigatória e fica no termo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fx = await leaseReady(t);
    await waive(t, fx.contract.id, () => true);
    const kd = await newDelivery(t, fx);
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx, { keysIdentification: undefined }), tenant.userId, t), code('LEGAL_KEY_DELIVERY_IDENTIFICATION_REQUIRED'));
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx, { keysIdentification: '   ' }), tenant.userId, t), code('LEGAL_KEY_DELIVERY_IDENTIFICATION_REQUIRED'));
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx, { keysIdentification: '  2 chaves da porta + 1 controle  ' }), tenant.userId, t);
    assert.equal(released.keysIdentification, '2 chaves da porta + 1 controle');
    assert.match(released.termText, /Identificação das chaves\/controles: 2 chaves da porta \+ 1 controle/);
  });
});

test('M5-A0084/§10: política de fotos por tipo de contrato com quantidade mínima, configurável pela empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const fx = await leaseReady(t);
    await waive(t, fx.contract.id, () => true);
    const kd = await newDelivery(t, fx);
    const padrao = await keyDeliveriesService.resolveKeyDeliveryPhotoPolicy(fx.contract, kd, t);
    assert.deepEqual([padrao.photosRequired, padrao.minPhotos, padrao.code], [false, 0, 'NOT_REQUIRED_LEASE_CHECKIN_SIGNED']);

    await upsertSetting('legal.chaves.fotos_minimas.LEASE_RESIDENTIAL', 2, tenant, tenant.userId, t);
    const p1 = await image(t, 'sala.png');
    const p2 = await image(t, 'cozinha.png');
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx), tenant.userId, t), code('LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED'));
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx, { photosFileIds: [p1.id] }), tenant.userId, t), (err) => {
      assert.equal(err.code, 'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED');
      assert.deepEqual([err.details.minPhotos, err.details.informed], [2, 1]);
      return true;
    });
    await assert.rejects(() => keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx, { photosFileIds: [p1.id, p1.id] }), tenant.userId, t), code('LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED'));
    const preview = await keyDeliveriesService.previewKeyDeliveryTerm(kd.id, {}, t);
    assert.deepEqual([preview.photosRequired, preview.minPhotos], [true, 2]);
    const released = await keyDeliveriesService.releaseKeyDelivery(kd.id, releaseBody(fx, { photosFileIds: [p1.id, p2.id] }), tenant.userId, t);
    assert.equal(released.photoPolicy, 'REQUIRED_BY_CONTRACT_TYPE');
    assert.match(released.termText, /no mínimo 2 fotos/);

    // Outro tipo de contrato continua com o seu próprio parâmetro (residencial não afeta comercial).
    const commercial = await leaseReady(t, 'LEASE_COMMERCIAL');
    const policyCommercial = await keyDeliveriesService.resolveKeyDeliveryPhotoPolicy(commercial.contract, { termType: null }, t);
    assert.equal(policyCommercial.minPhotos, 0);
    await assert.rejects(() => upsertSetting('legal.chaves.fotos_minimas.LEASE_RESIDENTIAL', -1, tenant, tenant.userId, t), code('SETTING_INVALID_VALUE'));
  });
});
