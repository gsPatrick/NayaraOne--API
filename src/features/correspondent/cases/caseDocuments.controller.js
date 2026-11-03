'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const AppError = require('../../../utils/AppError');
const service = require('./caseDocuments.service');

function tenant(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createRequirement = catchAsync(async (req, res) => {
  const requirement = await req.withTenantTransaction((t) =>
    service.createRequirement(req.params.id, req.body, req.auth.userId, tenant(req), t)
  );
  return success(res, { statusCode: 201, data: requirement });
});

const listRequirements = catchAsync(async (req, res) => {
  const canSeeDocuments = req.auth.permissions.includes('correspondent:documents:read');
  const requirements = await req.withTenantTransaction((t) =>
    service.listRequirements(req.params.id, tenant(req), t, { canSeeDocuments })
  );
  return success(res, { data: requirements });
});

const uploadDocument = catchAsync(async (req, res) => {
  const { requirementId, ...rest } = req.body || {};
  const document = await req.withTenantTransaction((t) =>
    service.uploadDocument(req.params.id, requirementId, rest, req.auth.userId, tenant(req), t)
  );
  // Quem não tem a permissão dedicada de ler documentos não recebe de volta a leitura automática
  // (nome, CPF, renda, conta extraídos do arquivo) nem a referência ao arquivo restrito.
  const canSeeDocuments = req.auth.permissions.includes('correspondent:documents:read');
  if (!canSeeDocuments) {
    const plain = typeof document.get === 'function' ? document.get({ plain: true }) : { ...document };
    delete plain.suggestedNote;
    delete plain.fileId;
    delete plain.providerExternalDocumentId;
    return success(res, { statusCode: 201, data: plain });
  }
  return success(res, { statusCode: 201, data: document });
});

const validateRequirement = catchAsync(async (req, res) => {
  // Validar um documento é conferi-lo: quem não pode ler documentos restritos não valida.
  if (!req.auth.permissions.includes('correspondent:documents:read')) {
    throw AppError.forbidden('Para validar um documento é preciso ter permissão de ler documentos do correspondente.', 'CORRESPONDENT_DOCUMENTS_READ_REQUIRED');
  }
  const requirement = await req.withTenantTransaction((t) =>
    service.validateRequirement(req.params.id, req.params.requirementId, req.auth.userId, tenant(req), t, { manualFields: req.body?.manualFields })
  );
  return success(res, { data: requirement });
});

const rejectRequirement = catchAsync(async (req, res) => {
  if (!req.auth.permissions.includes('correspondent:documents:read')) {
    throw AppError.forbidden('Para recusar um documento é preciso ter permissão de ler documentos do correspondente.', 'CORRESPONDENT_DOCUMENTS_READ_REQUIRED');
  }
  const requirement = await req.withTenantTransaction((t) =>
    service.rejectRequirement(req.params.id, req.params.requirementId, req.body?.reason, req.auth.userId, tenant(req), t)
  );
  return success(res, { data: requirement });
});

const dismissRequirement = catchAsync(async (req, res) => {
  const requirement = await req.withTenantTransaction((t) =>
    service.dismissRequirement(req.params.id, req.params.requirementId, req.body?.reason, req.auth.userId, tenant(req), t)
  );
  return success(res, { data: requirement });
});

// Histórico de versões do documento: o arquivo é restrito, então só com a permissão dedicada (a rota já exige).
const listDocumentVersions = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.listDocumentVersions(req.params.id, req.params.requirementId, tenant(req), t)
  );
  return success(res, { data: result });
});

module.exports = { createRequirement, listRequirements, uploadDocument, validateRequirement, rejectRequirement, dismissRequirement, listDocumentVersions };
