'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const legalController = require('./legal.controller');

const legalRouter = Router();

legalRouter.use(authMiddleware, tenantMiddleware);

// Contracts
legalRouter.post('/legal/contracts', requirePermission('legal:create'), legalController.createContract);
legalRouter.get('/legal/contracts', requirePermission('legal:read'), legalController.listContracts);
legalRouter.get('/legal/contracts/:id', requirePermission('legal:read'), legalController.getContract);
legalRouter.post('/legal/contracts/:id/transition', requirePermission('legal:approve'), legalController.transitionContract);
legalRouter.post('/legal/contracts/:id/parties', requirePermission('legal:create'), legalController.addContractParty);
legalRouter.get('/legal/contracts/:id/parties', requirePermission('legal:read'), legalController.listContractParties);

// Contract versions
legalRouter.post('/legal/contracts/:id/versions', requirePermission('legal:create'), legalController.createContractVersion);
legalRouter.get('/legal/contracts/:id/versions', requirePermission('legal:read'), legalController.listContractVersions);

// Signatures
legalRouter.post('/legal/contract-versions/:id/signatures', requirePermission('legal:sign'), legalController.initiateSignature);
legalRouter.get('/legal/contract-versions/:id/signatures', requirePermission('legal:read'), legalController.listSignaturesByContractVersion);
legalRouter.post('/legal/signatures/:externalSignatureId/webhook', requirePermission('legal:sign'), legalController.signatureWebhook);

// Guarantees
legalRouter.post('/legal/contracts/:contractId/guarantees', requirePermission('legal:create'), legalController.createGuarantee);
legalRouter.get('/legal/guarantees', requirePermission('legal:read'), legalController.listGuarantees);
legalRouter.get('/legal/guarantees/:id', requirePermission('legal:read'), legalController.getGuarantee);
legalRouter.patch('/legal/guarantees/:id', requirePermission('legal:update'), legalController.updateGuarantee);
legalRouter.delete('/legal/guarantees/:id', requirePermission('legal:update'), legalController.removeGuarantee);

// Inspections
legalRouter.post('/legal/inspections', requirePermission('legal:create'), legalController.createInspection);
legalRouter.get('/legal/inspections', requirePermission('legal:read'), legalController.listInspections);
legalRouter.get('/legal/inspections/compare', requirePermission('legal:read'), legalController.compareInspections);
legalRouter.get('/legal/inspections/:id', requirePermission('legal:read'), legalController.getInspection);
legalRouter.post('/legal/inspections/:id/complete', requirePermission('legal:update'), legalController.completeInspection);
legalRouter.post('/legal/inspections/:id/items', requirePermission('legal:create'), legalController.addInspectionItem);
legalRouter.get('/legal/inspections/:id/items', requirePermission('legal:read'), legalController.listInspectionItems);

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

module.exports = legalRouter;
