'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const controller = require('./procurement.controller');
const insuranceController = require('./insurance.controller');

const procurementRouter = Router();
procurementRouter.use(authMiddleware, tenantMiddleware);

procurementRouter.post('/procurement/purchase-requests', requirePermission('procurement:create'), controller.createPurchaseRequest);
procurementRouter.get('/procurement/purchase-requests', requirePermission('procurement:read'), controller.listPurchaseRequests);
procurementRouter.get('/procurement/purchase-requests/:id', requirePermission('procurement:read'), controller.getPurchaseRequest);
procurementRouter.post('/procurement/purchase-requests/:id/decide', requirePermission('procurement:approve'), controller.decidePurchaseRequest);

procurementRouter.post('/procurement/purchase-requests/:id/quotations', requirePermission('procurement:create'), controller.createQuotation);
procurementRouter.post('/procurement/quotations/:id/offers', requirePermission('procurement:create'), controller.submitSupplierOffer);
procurementRouter.get('/procurement/quotations/:id/compare', requirePermission('procurement:read'), controller.compareOffers);
procurementRouter.post('/procurement/offers/:id/award', requirePermission('procurement:approve'), controller.awardSupplierOffer);

procurementRouter.get('/procurement/purchase-orders', requirePermission('procurement:read'), controller.listPurchaseOrders);
procurementRouter.get('/procurement/purchase-orders/:id', requirePermission('procurement:read'), controller.getPurchaseOrder);
procurementRouter.post('/procurement/purchase-orders/:id/goods-receipts', requirePermission('procurement:create'), controller.confirmGoodsReceipt);
procurementRouter.get('/procurement/purchase-orders/:id/goods-receipts', requirePermission('procurement:read'), controller.listGoodsReceipts);
procurementRouter.get('/procurement/discrepancies', requirePermission('procurement:read'), controller.listDiscrepancies);
procurementRouter.post('/procurement/discrepancies/:id/resolve', requirePermission('procurement:approve'), controller.resolveDiscrepancy);

procurementRouter.post('/procurement/supplier-evaluations', requirePermission('procurement:create'), controller.evaluateSupplier);
procurementRouter.get('/procurement/supplier-evaluations', requirePermission('procurement:read'), controller.listSupplierEvaluations);

procurementRouter.post('/procurement/purchase-orders/:id/cancel', requirePermission('procurement:approve'), controller.cancelPurchaseOrder);

procurementRouter.post('/procurement/supplier-qualifications', requirePermission('procurement:create'), controller.upsertSupplierQualification);
procurementRouter.get('/procurement/supplier-qualifications', requirePermission('procurement:read'), controller.listSupplierQualifications);
procurementRouter.post('/procurement/supplier-qualifications/:id/decide', requirePermission('procurement:approve'), controller.decideSupplierDueDiligence);

// Insurance Hub (Marco 7 — "COMPRAS/PROCUREMENT + SEGUROS"). Emitir apólice e submeter sinistro
// movimentam dinheiro/compromisso real — mesma permissão de aprovação do resto do Compras.
procurementRouter.post('/procurement/insurance-policies', requirePermission('procurement:create'), insuranceController.createPolicy);
procurementRouter.get('/procurement/insurance-policies', requirePermission('procurement:read'), insuranceController.listPolicies);
procurementRouter.get('/procurement/insurance-policies/:id', requirePermission('procurement:read'), insuranceController.getPolicy);
procurementRouter.post('/procurement/insurance-policies/:id/quote', requirePermission('procurement:create'), insuranceController.quotePolicy);
procurementRouter.post('/procurement/insurance-policies/:id/issue', requirePermission('procurement:approve'), insuranceController.issuePolicy);
procurementRouter.post('/procurement/insurance-policies/:id/claims', requirePermission('procurement:create'), insuranceController.openClaim);
procurementRouter.post('/procurement/insurance-claims/:id/submit', requirePermission('procurement:approve'), insuranceController.submitClaim);
procurementRouter.post('/procurement/insurance-policies/:id/documents', requirePermission('procurement:create'), insuranceController.attachPolicyDocument);
procurementRouter.get('/procurement/insurance-policies/:id/documents', requirePermission('procurement:read'), insuranceController.listPolicyDocuments);
procurementRouter.get('/procurement/insurance-policies/:id/installments', requirePermission('procurement:read'), insuranceController.listPolicyInstallments);
procurementRouter.post('/procurement/insurance-installments/:installmentId/pay', requirePermission('procurement:approve'), insuranceController.payPolicyInstallment);

module.exports = procurementRouter;
