'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const service = require('./procurement.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createPurchaseRequest = catchAsync(async (req, res) => {
  const request = await req.withTenantTransaction((t) => service.createPurchaseRequest(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: request });
});
const listPurchaseRequests = catchAsync(async (req, res) => {
  const requests = await req.withTenantTransaction((t) => service.listPurchaseRequests(t, { status: req.query.status }));
  return success(res, { data: requests });
});
const getPurchaseRequest = catchAsync(async (req, res) => {
  const request = await req.withTenantTransaction((t) => service.getPurchaseRequest(req.params.id, t));
  return success(res, { data: request });
});
const decidePurchaseRequest = catchAsync(async (req, res) => {
  const request = await req.withTenantTransaction((t) => service.decidePurchaseRequest(req.params.id, req.body.decision, req.auth.userId, t));
  return success(res, { data: request });
});

const createQuotation = catchAsync(async (req, res) => {
  const quotation = await req.withTenantTransaction((t) => service.createQuotation(req.params.id, req.auth.userId, t));
  return success(res, { statusCode: 201, data: quotation });
});
const submitSupplierOffer = catchAsync(async (req, res) => {
  const offer = await req.withTenantTransaction((t) => service.submitSupplierOffer(req.params.id, req.body, t));
  return success(res, { statusCode: 201, data: offer });
});
const compareOffers = catchAsync(async (req, res) => {
  const offers = await req.withTenantTransaction((t) => service.compareOffers(req.params.id, t));
  return success(res, { data: offers });
});
const awardSupplierOffer = catchAsync(async (req, res) => {
  const order = await req.withTenantTransaction((t) => service.awardSupplierOffer(req.params.id, req.auth.userId, t));
  return success(res, { statusCode: 201, data: order });
});

const listPurchaseOrders = catchAsync(async (req, res) => {
  const orders = await req.withTenantTransaction((t) => service.listPurchaseOrders(t, { status: req.query.status }));
  return success(res, { data: orders });
});
const getPurchaseOrder = catchAsync(async (req, res) => {
  const order = await req.withTenantTransaction((t) => service.getPurchaseOrder(req.params.id, t));
  return success(res, { data: order });
});
const confirmGoodsReceipt = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const result = await req.withTenantTransaction((t) => service.confirmGoodsReceipt(req.params.id, req.body, actor, t));
  return success(res, { statusCode: 201, data: result });
});
const listDiscrepancies = catchAsync(async (req, res) => {
  const discrepancies = await req.withTenantTransaction((t) => service.listDiscrepancies(t, { status: req.query.status }));
  return success(res, { data: discrepancies });
});

const evaluateSupplier = catchAsync(async (req, res) => {
  const evaluation = await req.withTenantTransaction((t) => service.evaluateSupplier(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: evaluation });
});

module.exports = {
  createPurchaseRequest,
  listPurchaseRequests,
  getPurchaseRequest,
  decidePurchaseRequest,
  createQuotation,
  submitSupplierOffer,
  compareOffers,
  awardSupplierOffer,
  listPurchaseOrders,
  getPurchaseOrder,
  confirmGoodsReceipt,
  listDiscrepancies,
  evaluateSupplier,
};
