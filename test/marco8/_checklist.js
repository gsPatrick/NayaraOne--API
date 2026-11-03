'use strict';

// Ajudante dos testes do Marco 8: deixa o checklist do caso com um documento obrigatório validado
// (o envio exige checklist não vazio e completo).
const { File } = require('../../src/models');
const documentsService = require('../../src/features/correspondent/cases/caseDocuments.service');

async function validarChecklist(caso, transaction, tenant, documentType = 'RG_CPF') {
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
  const requirement = await documentsService.createRequirement(caso.id, { documentType, required: true }, tenant.userId, ctx, transaction);
  const file = await File.create(
    { ...ctx, fileName: `doc-${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`, mimeType: 'application/pdf', sizeBytes: 20000, storageKey: `test/${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`, uploadedByUserId: tenant.userId },
    { transaction }
  );
  await documentsService.uploadDocument(caso.id, requirement.id, { fileId: file.id }, tenant.userId, ctx, transaction);
  await documentsService.validateRequirement(caso.id, requirement.id, tenant.userId, ctx, transaction, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
  return { requirement, file };
}

module.exports = { validarChecklist };
