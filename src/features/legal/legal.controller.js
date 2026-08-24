'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const contractsService = require('./contracts.service');
const contractVersionsService = require('./contractVersions.service');
const signaturesService = require('./signatures.service');
const guaranteesService = require('./guarantees.service');
const inspectionsService = require('./inspections.service');
const keyDeliveriesService = require('./keyDeliveries.service');
const legalCasesService = require('./legalCases.service');
const legalDeadlinesService = require('./legalDeadlines.service');
const evidencePackagesService = require('./evidencePackages.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

// --- Contracts ---
const createContract = catchAsync(async (req, res) => {
  const contract = await req.withTenantTransaction((t) => contractsService.createContract(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: contract });
});
const listContracts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    contractsService.listContracts(t, { status: req.query.status, contractType: req.query.contractType, propertyId: req.query.propertyId })
  );
  return success(res, { data: items });
});
const getContract = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractsService.getContract(req.params.id, t));
  return success(res, { data: item });
});
const transitionContract = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction(async (t) => {
    const contract = await contractsService.getContract(req.params.id, t);
    return contractsService.transitionContractStatus(contract, req.body.targetStatus, req.auth.userId, t);
  });
  return success(res, { data: item });
});
const addContractParty = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractsService.addContractParty(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listContractParties = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => contractsService.listContractParties(req.params.id, t));
  return success(res, { data: items });
});

// --- Contract versions ---
const createContractVersion = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractVersionsService.createContractVersion(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listContractVersions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => contractVersionsService.listContractVersions(req.params.id, t));
  return success(res, { data: items });
});

// --- Signatures ---
const initiateSignature = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    signaturesService.initiateSignature(req.params.id, req.body.signerPersonIds, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: items });
});
const listSignaturesByContractVersion = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => signaturesService.listSignaturesByContractVersion(req.params.id, t));
  return success(res, { data: items });
});
// Webhook de assinatura — DECISÃO DE ENGENHARIA: um webhook de provedor real chegaria SEM
// JWT de usuário (é o provedor externo chamando, autenticado por segredo/HMAC próprio), e
// precisaria resolver group_id/company_id a partir do próprio Signature antes de aplicar
// RLS. Como este marco só tem o SandboxSignatureAdapter (mock, sem provedor real por trás),
// mantemos esta rota atrás do MESMO authMiddleware/tenantMiddleware das demais rotas de
// legal (exige "legal:sign") — ou seja, aqui ela é chamada como uma ação autenticada que
// SIMULA a chegada do webhook, não como endpoint público. Um adapter de provedor real
// exigiria uma rota pública dedicada fora do router autenticado, validando a assinatura
// HMAC do provedor antes de abrir a transação com SET LOCAL — esse trabalho fica para quando
// houver um provedor real configurado.
const signatureWebhook = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => signaturesService.handleSignatureWebhook(req.params.externalSignatureId, req.body, t));
  return success(res, { data: result });
});

// --- Guarantees ---
const createGuarantee = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteesService.createGuarantee(req.params.contractId, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listGuarantees = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    guaranteesService.listGuarantees(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getGuarantee = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteesService.getGuarantee(req.params.id, t));
  return success(res, { data: item });
});
const updateGuarantee = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteesService.updateGuarantee(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const removeGuarantee = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => guaranteesService.deleteGuarantee(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Inspections ---
const createInspection = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.createInspection(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listInspections = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    inspectionsService.listInspections(t, {
      propertyId: req.query.propertyId,
      contractId: req.query.contractId,
      status: req.query.status,
      inspectionType: req.query.inspectionType,
    })
  );
  return success(res, { data: items });
});
const getInspection = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.getInspection(req.params.id, t));
  return success(res, { data: item });
});
const completeInspection = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.completeInspection(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const addInspectionItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.addInspectionItem(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listInspectionItems = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => inspectionsService.listInspectionItems(req.params.id, t));
  return success(res, { data: items });
});
const compareInspections = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    inspectionsService.compareInspections(req.query.entryInspectionId, req.query.exitInspectionId, t)
  );
  return success(res, { data: result });
});

// --- Key deliveries ---
const createKeyDelivery = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => keyDeliveriesService.createKeyDelivery(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listKeyDeliveries = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    keyDeliveriesService.listKeyDeliveries(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getKeyDelivery = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => keyDeliveriesService.getKeyDelivery(req.params.id, t));
  return success(res, { data: item });
});
const releaseKeyDelivery = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => keyDeliveriesService.releaseKeyDelivery(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Legal cases ---
const createLegalCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.createLegalCase(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listLegalCases = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    legalCasesService.listLegalCases(t, { status: req.query.status, caseType: req.query.caseType, contractId: req.query.contractId })
  );
  return success(res, { data: items });
});
const getLegalCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.getLegalCase(req.params.id, t));
  return success(res, { data: item });
});
const updateLegalCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.updateLegalCase(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const linkCaseToTask = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.linkCaseToTask(req.params.id, req.body.taskId, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Legal deadlines ---
const createLegalDeadline = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalDeadlinesService.createLegalDeadline(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listLegalDeadlines = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    legalDeadlinesService.listLegalDeadlines(t, { legalCaseId: req.query.legalCaseId, status: req.query.status, severity: req.query.severity })
  );
  return success(res, { data: items });
});
const updateLegalDeadline = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalDeadlinesService.updateLegalDeadline(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Evidence packages ---
const createEvidencePackage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    evidencePackagesService.createEvidencePackage(req.params.id, req.body.manifestItems, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listEvidencePackages = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => evidencePackagesService.listEvidencePackages(req.params.id, t));
  return success(res, { data: items });
});
const getEvidencePackage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => evidencePackagesService.getEvidencePackage(req.params.id, t));
  return success(res, { data: item });
});

module.exports = {
  createContract, listContracts, getContract, transitionContract, addContractParty, listContractParties,
  createContractVersion, listContractVersions,
  initiateSignature, listSignaturesByContractVersion, signatureWebhook,
  createGuarantee, listGuarantees, getGuarantee, updateGuarantee, removeGuarantee,
  createInspection, listInspections, getInspection, completeInspection, addInspectionItem, listInspectionItems, compareInspections,
  createKeyDelivery, listKeyDeliveries, getKeyDelivery, releaseKeyDelivery,
  createLegalCase, listLegalCases, getLegalCase, updateLegalCase, linkCaseToTask,
  createLegalDeadline, listLegalDeadlines, updateLegalDeadline,
  createEvidencePackage, listEvidencePackages, getEvidencePackage,
};
