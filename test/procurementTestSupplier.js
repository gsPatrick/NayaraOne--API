'use strict';

// Revisão Marco 7 (19/10/2026, item B10): a adjudicação passou a exigir, para QUALQUER
// fornecedor, qualificação com documento anexado e vigência válida (antes só o alto risco era
// checado e fornecedor sem qualificação passava). Os testes de Compras usam este helper para
// criar um fornecedor real (Person) já qualificado — nunca um id arbitrário.

const { uniqueSuffix } = require('./testHelpers');

function farFutureDateOnly(years = 2) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

async function createQualifiedSupplier(tenant, transaction, { highRisk = false, legalName } = {}) {
  const { Person } = require('../src/models');
  const filesService = require('../src/features/files/files.service');
  const procurementService = require('../src/features/procurement/procurement.service');
  const suffix = uniqueSuffix();
  const supplier = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PJ',
      legalName: legalName || `Fornecedor de teste ${suffix}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  const file = await filesService.uploadFile(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: `documentos-fornecedor-${suffix}.pdf`,
      mimeType: 'application/pdf',
      contentBase64: Buffer.from(`DOCUMENTOS FORNECEDOR ${suffix}`).toString('base64'),
      category: 'generic',
    },
    tenant.userId,
    transaction
  );
  const qualification = await procurementService.upsertSupplierQualification(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      supplierPersonId: supplier.id,
      documentFileIds: [file.id],
      validUntil: farFutureDateOnly(),
      highRisk,
    },
    tenant.userId,
    { canApprove: true },
    transaction
  );
  return { supplier, supplierPersonId: supplier.id, qualification, documentFileId: file.id };
}

module.exports = { createQualifiedSupplier, farFutureDateOnly };
