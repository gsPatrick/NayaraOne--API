'use strict';

const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const AppError = require('../src/utils/AppError');
const { File } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProperty(transaction) {
  const suffix = uniqueSuffix();
  return propertiesService.createProperty(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel Vistoria ${suffix}`,
      internalCode: `VIS-${suffix}`,
      propertyType: 'RESIDENTIAL',
    },
    tenant.userId,
    transaction
  );
}

// Escopo Marco 5 (Vistorias) — reportado pela cliente 14/09/2026: fotos/vídeos, assinatura
// digital, relatório PDF imutável com hash e orçamento de danos não existiam. Este arquivo
// prova o fluxo completo ponta a ponta.

test('vistoria: item DAMAGED exige damageDescription e estimatedBudget', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_OUT' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => inspectionsService.addInspectionItem(inspection.id, { itemName: 'Piso da sala', condition: 'DAMAGED' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_ITEM_VALIDATION');
        return true;
      }
    );

    const item = await inspectionsService.addInspectionItem(
      inspection.id,
      { itemName: 'Piso da sala', condition: 'DAMAGED', damageDescription: 'Piso trincado em 3 pontos', estimatedBudget: 850.5 },
      tenant.userId,
      transaction
    );
    assert.equal(item.damageDescription, 'Piso trincado em 3 pontos');
    assert.equal(Number(item.estimatedBudget), 850.5);
  });
});

test('vistoria: fotos/vídeos podem ser anexados a um item via File + FileLink', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );
    const item = await inspectionsService.addInspectionItem(inspection.id, { itemName: 'Cozinha', condition: 'GOOD' }, tenant.userId, transaction);

    const file = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        storageKey: `homo-qa/inspections/${uniqueSuffix()}.jpg`,
        fileName: 'cozinha-entrada.jpg',
        mimeType: 'image/jpeg',
        uploadedByUserId: tenant.userId,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    const link = await inspectionsService.attachInspectionItemMedia(item.id, { fileId: file.id, mediaType: 'PHOTO' }, tenant.userId, transaction);
    assert.equal(link.relatedEntityType, 'InspectionItem');
    assert.equal(link.relatedEntityId, item.id);
    assert.equal(link.purpose, 'PHOTO');

    const media = await inspectionsService.listInspectionItemMedia(item.id, transaction);
    assert.equal(media.length, 1);
    assert.equal(media[0].fileId, file.id);
  });
});

test('vistoria: assinatura digital só é possível depois de COMPLETED, uma vez por parte, hash verificável', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );

    // Antes de COMPLETED, não pode assinar.
    await assert.rejects(
      () => inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'base64-fake-signature' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_NOT_COMPLETED');
        return true;
      }
    );

    await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);

    const signature = await inspectionsService.signInspection(
      inspection.id,
      { partyRole: 'TENANT', signaturePayload: 'base64-fake-signature' },
      tenant.userId,
      transaction
    );
    assert.ok(signature.signatureHash);
    assert.equal(signature.signatureHash.length, 64); // sha256 hex

    // A mesma parte não pode assinar duas vezes.
    await assert.rejects(
      () => inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'outro-payload' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_ALREADY_SIGNED');
        return true;
      }
    );

    // Outra parte pode assinar normalmente.
    const landlordSignature = await inspectionsService.signInspection(
      inspection.id,
      { partyRole: 'LANDLORD', signaturePayload: 'base64-fake-signature-landlord' },
      tenant.userId,
      transaction
    );
    assert.notEqual(landlordSignature.signatureHash, signature.signatureHash);

    const signatures = await inspectionsService.listInspectionSignatures(inspection.id, transaction);
    assert.equal(signatures.length, 2);
  });
});

test('vistoria: relatório PDF só é gerado depois de COMPLETED, é imutável (hash bate com os bytes) e é real (assinatura binária %PDF)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_OUT' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(
      inspection.id,
      { itemName: 'Piso da sala', condition: 'DAMAGED', damageDescription: 'Piso trincado', estimatedBudget: 500 },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => inspectionsService.generateInspectionReport(inspection.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_NOT_COMPLETED');
        return true;
      }
    );

    await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);
    await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'sig-tenant' }, tenant.userId, transaction);

    const generated = await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, transaction);
    assert.ok(generated.reportHash);
    assert.ok(generated.sizeBytes > 0);

    const { pdfBytes, reportHash } = await inspectionsService.getInspectionReport(inspection.id, transaction);
    assert.equal(reportHash, generated.reportHash);
    // Confirma que é um PDF binário real, não um texto/mock — assinatura de arquivo %PDF.
    assert.equal(pdfBytes.subarray(0, 4).toString('ascii'), '%PDF');

    // Hash gravado precisa bater EXATAMENTE com o SHA-256 dos bytes retornados (prova de integridade).
    const recomputed = crypto.createHash('sha256').update(pdfBytes).digest('hex');
    assert.equal(recomputed, reportHash);
  });
});

test('vistoria: getInspectionReport detecta adulteração dos bytes (hash não bate mais)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_OUT' },
      tenant.userId,
      transaction
    );
    await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);
    await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, transaction);

    // Simula adulteração direta no banco (por fora da aplicação) — precisa ser detectada.
    const { Inspection } = require('../src/models');
    await Inspection.update({ reportPdfBytes: Buffer.from('%PDF-adulterado') }, { where: { id: inspection.id }, transaction });

    await assert.rejects(
      () => inspectionsService.getInspectionReport(inspection.id, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_REPORT_INTEGRITY_MISMATCH');
        return true;
      }
    );
  });
});

test('vistoria: compareInspections continua funcionando junto com os novos campos de dano/orçamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const entry = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );
    const exit = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, inspectionType: 'CHECK_OUT' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(entry.id, { itemName: 'Piso da sala', condition: 'GOOD' }, tenant.userId, transaction);
    await inspectionsService.addInspectionItem(
      exit.id,
      { itemName: 'Piso da sala', condition: 'DAMAGED', damageDescription: 'Trincado na saída', estimatedBudget: 300 },
      tenant.userId,
      transaction
    );

    const comparison = await inspectionsService.compareInspections(entry.id, exit.id, transaction);
    assert.equal(comparison.divergences.length, 1);
    assert.equal(comparison.divergences[0].entryCondition, 'GOOD');
    assert.equal(comparison.divergences[0].exitCondition, 'DAMAGED');
  });
});
