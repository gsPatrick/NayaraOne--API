'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const legalController = require('./legal.controller');

const legalRouter = Router();

// Webhook público do Clicksign — NÃO fica aqui. Bug real encontrado em produção (19/09/2026,
// testado com assinatura de verdade): registrar a rota pública ANTES de
// `legalRouter.use(authMiddleware, ...)` não bastava, porque `routes/index.js` monta VÁRIOS
// routers no mesmo prefixo "/v1" ANTES do legalRouter (groups, companies, units, users,
// memberships, roles, people, properties, crm, radar, finance) — e cada um deles tem seu
// próprio `algumRouter.use(authMiddleware)` SEM path, que intercepta QUALQUER requisição que
// chegue a esse router, não só as rotas dele. Como o Express tenta cada router montado em
// "/v1" em ordem até um responder, o groupsRouter (o primeiro da lista) já rejeitava toda
// chamada ao nosso webhook com 401 antes do legalRouter sequer ser tentado. A rota pública de
// verdade agora está em src/routes/index.js, registrada ANTES de qualquer router com gate de
// autenticação — ver clicksignPublicWebhook em legal.controller.js.
legalRouter.use(authMiddleware, tenantMiddleware);

// Contracts
legalRouter.post('/legal/contracts', requirePermission('legal:create'), legalController.createContract);
legalRouter.get('/legal/contracts', requirePermission('legal:read'), legalController.listContracts);
legalRouter.get('/legal/contracts/:id', requirePermission('legal:read'), legalController.getContract);
legalRouter.post('/legal/contracts/:id/transition', requirePermission('legal:approve'), legalController.transitionContract);
legalRouter.post('/legal/contracts/:id/parties', requirePermission('legal:create'), legalController.addContractParty);
legalRouter.get('/legal/contracts/:id/parties', requirePermission('legal:read'), legalController.listContractParties);
// AUD-004: correção auditada de dados já gravados (não é a máquina de estados) — ação HIGH,
// exige MFA recente e motivo obrigatório (ver correctContractData em contracts.service.js).
legalRouter.patch('/legal/contracts/:id/correct', requirePermission('legal:update'), requireRecentMfa, legalController.correctContractData);

// Contract versions
legalRouter.post('/legal/contracts/:id/versions', requirePermission('legal:create'), legalController.createContractVersion);
legalRouter.get('/legal/contracts/:id/versions', requirePermission('legal:read'), legalController.listContractVersions);

legalRouter.post('/legal/contracts/:id/amendments', requirePermission('legal:create'), legalController.createContractAmendment);
legalRouter.get('/legal/contracts/:id/amendments', requirePermission('legal:read'), legalController.listContractAmendments);
legalRouter.get('/legal/amendments/:id', requirePermission('legal:read'), legalController.getContractAmendment);
legalRouter.post('/legal/amendments/:id/sign', requirePermission('legal:update'), legalController.signContractAmendment);

// Signatures
legalRouter.post('/legal/contract-versions/:id/signatures', requirePermission('legal:sign'), legalController.initiateSignature);
legalRouter.get('/legal/contract-versions/:id/signatures', requirePermission('legal:read'), legalController.listSignaturesByContractVersion);
legalRouter.post('/legal/signatures/:externalSignatureId/webhook', requirePermission('legal:sign'), legalController.signatureWebhook);
legalRouter.get('/legal/signatures/:id/status', requirePermission('legal:sign'), legalController.checkSignatureStatus);
legalRouter.post('/legal/signatures/:id/cancel', requirePermission('legal:sign'), legalController.cancelSignature);

// Guarantees
legalRouter.post('/legal/contracts/:contractId/guarantees', requirePermission('legal:create'), legalController.createGuarantee);
legalRouter.get('/legal/guarantees', requirePermission('legal:read'), legalController.listGuarantees);
legalRouter.get('/legal/guarantees/:id', requirePermission('legal:read'), legalController.getGuarantee);
legalRouter.patch('/legal/guarantees/:id', requirePermission('legal:update'), legalController.updateGuarantee);
legalRouter.delete('/legal/guarantees/:id', requirePermission('legal:update'), legalController.removeGuarantee);

// Inspections
legalRouter.post('/legal/inspections', requirePermission('legal:create'), legalController.createInspection);
// FIX (Bug 4, atomicidade): cria vistoria + itens em UMA transação — se qualquer item for
// inválido, nada é gravado (nem a vistoria, nem nenhum item). Ver createInspectionWithItems.
legalRouter.post('/legal/inspections/with-items', requirePermission('legal:create'), legalController.createInspectionWithItems);
legalRouter.get('/legal/inspections', requirePermission('legal:read'), legalController.listInspections);
legalRouter.get('/legal/inspections/compare', requirePermission('legal:read'), legalController.compareInspections);
legalRouter.get('/legal/inspections/:id', requirePermission('legal:read'), legalController.getInspection);
legalRouter.post('/legal/inspections/:id/complete', requirePermission('legal:update'), legalController.completeInspection);
legalRouter.post('/legal/inspections/:id/items', requirePermission('legal:create'), legalController.addInspectionItem);
legalRouter.get('/legal/inspections/:id/items', requirePermission('legal:read'), legalController.listInspectionItems);
legalRouter.post('/legal/inspections/items/:itemId/media', requirePermission('legal:create'), legalController.attachInspectionItemMedia);
legalRouter.get('/legal/inspections/items/:itemId/media', requirePermission('legal:read'), legalController.listInspectionItemMedia);
legalRouter.post('/legal/inspections/:id/sign', requirePermission('legal:update'), requireRecentMfa, legalController.signInspection);
legalRouter.get('/legal/inspections/:id/signatures', requirePermission('legal:read'), legalController.listInspectionSignatures);
legalRouter.post('/legal/inspections/:id/report', requirePermission('legal:update'), legalController.generateInspectionReport);
legalRouter.get('/legal/inspections/:id/report', requirePermission('legal:read'), legalController.getInspectionReport);

// Key deliveries
legalRouter.post('/legal/key-deliveries', requirePermission('legal:create'), legalController.createKeyDelivery);
legalRouter.get('/legal/key-deliveries', requirePermission('legal:read'), legalController.listKeyDeliveries);
legalRouter.get('/legal/key-deliveries/:id', requirePermission('legal:read'), legalController.getKeyDelivery);
legalRouter.post('/legal/key-deliveries/:id/release', requirePermission('legal:deliverKeys'), legalController.releaseKeyDelivery);

// Legal cases
legalRouter.post('/legal/cases', requirePermission('legal:create'), legalController.createLegalCase);
legalRouter.get('/legal/cases', requirePermission('legal:read'), legalController.listLegalCases);
legalRouter.get('/legal/cases/:id', requirePermission('legal:read'), legalController.getLegalCase);
legalRouter.patch('/legal/cases/:id', requirePermission('legal:update'), legalController.updateLegalCase);
legalRouter.post('/legal/cases/:id/link-task', requirePermission('legal:update'), legalController.linkCaseToTask);

// Legal deadlines
legalRouter.post('/legal/cases/:id/deadlines', requirePermission('legal:create'), legalController.createLegalDeadline);
legalRouter.get('/legal/deadlines', requirePermission('legal:read'), legalController.listLegalDeadlines);
legalRouter.patch('/legal/deadlines/:id', requirePermission('legal:update'), legalController.updateLegalDeadline);

// Evidence packages
legalRouter.post('/legal/cases/:id/evidence-packages', requirePermission('legal:create'), legalController.createEvidencePackage);
legalRouter.get('/legal/cases/:id/evidence-packages', requirePermission('legal:read'), legalController.listEvidencePackages);
legalRouter.get('/legal/evidence-packages/:id', requirePermission('legal:read'), legalController.getEvidencePackage);
// M5-28/M5-29: export verificável do dossiê e leitura da cadeia de custódia.
legalRouter.get('/legal/evidence-packages/:id/export', requirePermission('legal:read'), legalController.exportEvidencePackage);
legalRouter.get('/legal/evidence-packages/:id/access-log', requirePermission('legal:read'), legalController.listEvidencePackageAccessLog);

module.exports = legalRouter;
