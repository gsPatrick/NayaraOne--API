'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const { publishOffer } = require('../src/features/properties/publish.service');
const { PropertyMedia, PropertyDocument } = require('../src/models');

// Prova pedida pela auditoria externa (Abacus AI, 11/10/2026): "Trava de vídeo precede a de
// fotos; não foi possível isolar o teste de fotos." Este arquivo isola cada gate de publicação
// (vídeo, fotos mínimas, documentos) individualmente, provando que são 3 checagens
// independentes via Motor de Regras (REG-IMO-001, REG-IMO-PHOTO-MIN, REG-IMO-DOCS-001), não uma
// trava única que mascara as outras.

async function seedProperty(tenant, transaction) {
  const property = await propertiesService.createProperty(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel gate ${uniqueSuffix()}`,
      internalCode: `IC-GATE-${uniqueSuffix()}`,
      propertyType: 'RESIDENTIAL',
    },
    tenant.userId,
    transaction
  );
  const offer = await offersService.createOffer(
    property.id,
    { offerType: 'SALE', askingPrice: 500000 },
    tenant.userId,
    transaction
  );
  return { property, offer };
}

async function addVideo(property, tenant, transaction) {
  await PropertyMedia.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId: property.id,
      mediaType: 'VIDEO',
      storageKey: `gate-video-${property.id}.mp4`,
      originalName: 'video.mp4',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function addApprovedPhotos(property, tenant, transaction, count) {
  for (let i = 0; i < count; i += 1) {
    await PropertyMedia.create(
      {
        groupId: property.groupId,
        companyId: property.companyId,
        propertyId: property.id,
        mediaType: 'PHOTO',
        qualityStatus: 'APPROVED',
        storageKey: `gate-photo-${property.id}-${i}.jpg`,
        originalName: `foto-${i}.jpg`,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
  }
}

async function addRequiredDocs(property, tenant, transaction) {
  await PropertyDocument.create(
    { groupId: property.groupId, companyId: property.companyId, propertyId: property.id, documentType: 'REGISTRY', valueNumber: `MAT-${property.id}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  await PropertyDocument.create(
    { groupId: property.groupId, companyId: property.companyId, propertyId: property.id, documentType: 'IPTU', valueNumber: `IPTU-${property.id}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
}

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('gate de publicação: vídeo presente mas fotos ABAIXO do mínimo bloqueia especificamente por REG-IMO-PHOTO-MIN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { property, offer } = await seedProperty(tenant, transaction);
    await addVideo(property, tenant, transaction);
    await addApprovedPhotos(property, tenant, transaction, 1); // abaixo do mínimo (3)
    await addRequiredDocs(property, tenant, transaction);

    await assert.rejects(
      () => publishOffer(offer.id, tenant, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN');
        return true;
      }
    );
  });
});

test('gate de publicação: fotos e documentos OK mas SEM vídeo bloqueia especificamente por REG-IMO-001', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { property, offer } = await seedProperty(tenant, transaction);
    await addApprovedPhotos(property, tenant, transaction, 3);
    await addRequiredDocs(property, tenant, transaction);

    await assert.rejects(
      () => publishOffer(offer.id, tenant, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001');
        return true;
      }
    );
  });
});

test('gate de publicação: vídeo e fotos OK mas SEM documentos mínimos bloqueia especificamente por REG-IMO-DOCS-001', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { property, offer } = await seedProperty(tenant, transaction);
    await addVideo(property, tenant, transaction);
    await addApprovedPhotos(property, tenant, transaction, 3);

    await assert.rejects(
      () => publishOffer(offer.id, tenant, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001');
        return true;
      }
    );
  });
});

test('gate de publicação: vídeo + fotos mínimas + documentos OK publica normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { property, offer } = await seedProperty(tenant, transaction);
    await addVideo(property, tenant, transaction);
    await addApprovedPhotos(property, tenant, transaction, 3);
    await addRequiredDocs(property, tenant, transaction);

    const { property: published } = await publishOffer(offer.id, tenant, tenant.userId, transaction);
    assert.equal(published.publicationStatus, 'PUBLISHED');
  });
});
