'use strict';

// Dados de partida do Jurídico para o contract test (M9-D842, não é teste): vistoria com um item e um arquivo para anexar. Banco descartável.
const { withTenantTransaction } = require('../../testHelpers');
const propertiesService = require('../../../src/features/properties/properties.service');
const inspectionsService = require('../../../src/features/legal/inspections.service');
const { File } = require('../../../src/models');

const suffix = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

/** Item de vistoria ainda não assinada e uma foto já enviada ao armazenamento. */
async function inspectionItem(_vars, { tenants }) {
  const A = tenants.A;
  return withTenantTransaction(A, async (transaction) => {
    const property = await propertiesService.createProperty({ groupId: A.groupId, companyId: A.companyId, title: `QA-M9 Imóvel ${suffix()}`, internalCode: `M9D842-${suffix()}`, propertyType: 'RESIDENTIAL' }, A.userId, transaction);
    const inspection = await inspectionsService.createInspection({ groupId: A.groupId, companyId: A.companyId, propertyId: property.id, inspectionType: 'CHECK_IN' }, A.userId, transaction);
    const item = await inspectionsService.addInspectionItem(inspection.id, { itemName: 'Cozinha', condition: 'GOOD' }, A.userId, transaction);
    const file = await File.create({
      groupId: A.groupId, companyId: A.companyId, storageKey: `qa-m9/contrato/${suffix()}.jpg`, fileName: 'cozinha.jpg', mimeType: 'image/jpeg', sizeBytes: 10, uploadedByUserId: A.userId, createdBy: A.userId, updatedBy: A.userId,
    }, { transaction });
    return { inspectionItemId: item.id, mediaFileId: file.id };
  });
}

module.exports = { inspectionItem };
