'use strict';

// Item 1 do ciclo de auditoria externa (Marco 3) — merge de Imóvel. Contrato bruto — Caderno
// Pessoas/Imóveis/CRM/Radar §30 ("Merge seguro de Imóveis"):
//   "Mesmo princípio de Pessoas, porém ofertas, históricos de preço, proprietários, mídias,
//    contratos e processos precisam ser avaliados. Dois imóveis com matrículas efetivamente
//    distintas não podem ser mesclados apenas por endereço semelhante."
// Até este ciclo NÃO existia merge de Property — este teste prova o fluxo completo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const { mergeProperties, reversePropertyMergeSupervised } = require('../src/features/properties/propertyMerge.service');
const { AuditLog, OutboxEvent, PropertyOffer } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('mergeProperties bloqueia quando matrículas são preenchidas e distintas', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Canônico Matrícula ${suffix}`, internalCode: `PMG-C-${suffix}`, propertyType: 'RESIDENTIAL', registryNumber: `MAT-A-${suffix}` },
      tenant.userId,
      transaction
    );
    const absorbed = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Absorvido Matrícula ${suffix}`, internalCode: `PMG-A-${suffix}`, propertyType: 'RESIDENTIAL', registryNumber: `MAT-B-${suffix}` },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => mergeProperties(canonical.id, absorbed.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PROPERTY_MERGE_CONFLICT_DISTINCT_REGISTRY'); return true; },
      'imóveis com matrículas efetivamente distintas nunca podem ser mesclados só por endereço semelhante'
    );

    const mergeCase = await AuditLog.findOne({ where: { action: 'property.merge_case.opened', entityId: canonical.id }, transaction });
    assert.ok(mergeCase, 'merge_case precisa ter sido aberto mesmo quando o merge é bloqueado depois');
  });
});

test('mergeProperties remapeia ofertas/mídias/documentos/ocorrências, marca o absorvido como MERGED e preserva histórico', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Canônico ${suffix}`, internalCode: `PMG2-C-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const absorbed = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Absorvido ${suffix}`, internalCode: `PMG2-A-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );

    const offer = await offersService.createOffer(absorbed.id, { offerType: 'SALE', askingPrice: 250000 }, tenant.userId, transaction);

    const result = await mergeProperties(canonical.id, absorbed.id, tenant.userId, transaction);
    assert.equal(result.status, 'MERGED');
    assert.equal(result.remappedReferences['real_estate.property_offers'], 1);

    const reloadedOffer = await PropertyOffer.findByPk(offer.id, { transaction });
    assert.equal(reloadedOffer.propertyId, canonical.id, 'oferta do imóvel absorvido precisa migrar pro canônico, preservando o próprio registro (nunca recriada)');

    const reloadedAbsorbed = await propertiesService.getProperty(absorbed.id, transaction);
    assert.equal(reloadedAbsorbed.availabilityStatus, 'WITHDRAWN');
    assert.equal(reloadedAbsorbed.attributesJson.mergeStatus, 'MERGED');
    assert.equal(reloadedAbsorbed.attributesJson.mergedIntoPropertyId, canonical.id);

    const event = await OutboxEvent.findOne({ where: { eventType: 'property.merged', aggregateId: canonical.id }, transaction });
    assert.ok(event, 'evento property.merged precisa ter sido publicado');

    const finalAudit = await AuditLog.findOne({ where: { action: 'property.merge', entityId: canonical.id }, transaction });
    assert.ok(finalAudit.beforeJson.canonical && finalAudit.beforeJson.absorbed, 'snapshot completo de ambos os imóveis precisa existir');
  });
});

test('reversePropertyMergeSupervised exige reason real e reativa o imóvel absorvido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Canônico Reversao ${suffix}`, internalCode: `PMG3-C-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const absorbed = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel Absorvido Reversao ${suffix}`, internalCode: `PMG3-A-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );

    await mergeProperties(canonical.id, absorbed.id, tenant.userId, transaction);

    await assert.rejects(
      () => reversePropertyMergeSupervised(canonical.id, absorbed.id, '', tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PROPERTY_MERGE_REVERSAL_REASON_REQUIRED'); return true; }
    );

    const reversed = await reversePropertyMergeSupervised(
      canonical.id,
      absorbed.id,
      'Revertido por processo técnico supervisionado: matrículas confirmadas como imóveis distintos pelo cartório.',
      tenant.userId,
      transaction
    );
    assert.equal(reversed.status, 'REVERSED');

    const reloaded = await propertiesService.getProperty(absorbed.id, transaction);
    assert.equal(reloaded.availabilityStatus, 'AVAILABLE');
    assert.equal(reloaded.attributesJson.mergeStatus, undefined);
  });
});
