'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const inventoryNayService = require('./inventoryNay.service');
const receiptOcrService = require('./receiptOcr.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}
function tenantOf(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const generatePurchaseSuggestions = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => inventoryNayService.generatePurchaseSuggestions(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: result });
});

const listPurchaseSuggestions = catchAsync(async (req, res) => {
  const rows = await req.withTenantTransaction((t) =>
    inventoryNayService.listPurchaseSuggestions(req.auth.groupId, req.auth.companyId, t, { status: req.query.status, inventoryItemId: req.query.inventoryItemId })
  );
  return success(res, { data: rows });
});

const approvePurchaseSuggestion = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId };
  const result = await req.withTenantTransaction((t) => inventoryNayService.approvePurchaseSuggestion(req.params.id, req.auth.groupId, req.auth.companyId, req.body, actor, t));
  return success(res, { statusCode: 201, data: result });
});

const rejectPurchaseSuggestion = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId };
  const result = await req.withTenantTransaction((t) => inventoryNayService.rejectPurchaseSuggestion(req.params.id, req.auth.groupId, req.auth.companyId, req.body, actor, t));
  return success(res, { data: result });
});

const listLossCaseAnomalies = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    inventoryNayService.analyzeLossCaseAnomalies(tenantOf(req), { windowDays: req.query.windowDays, lossCaseId: req.query.lossCaseId }, t)
  );
  return success(res, { data: result });
});

const suggestReceiptFromInvoice = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => receiptOcrService.suggestReceiptFromInvoice(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: result });
});

module.exports = {
  generatePurchaseSuggestions,
  listPurchaseSuggestions,
  approvePurchaseSuggestion,
  rejectPurchaseSuggestion,
  listLossCaseAnomalies,
  suggestReceiptFromInvoice,
};
