'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const controller = require('./procurement.controller');

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
procurementRouter.get('/procurement/discrepancies', requirePermission('procurement:read'), controller.listDiscrepancies);

procurementRouter.post('/procurement/supplier-evaluations', requirePermission('procurement:create'), controller.evaluateSupplier);

module.exports = procurementRouter;
