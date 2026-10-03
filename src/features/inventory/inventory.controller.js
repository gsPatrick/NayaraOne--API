'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const itemsService = require('./items.service');
const movementsService = require('./movements.service');
const receiptsService = require('./receipts.service');
const requisitionsService = require('./requisitions.service');
const assetsService = require('./assets.service');
const toolLoansService = require('./toolLoans.service');
const maintenanceService = require('./maintenance.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => itemsService.createItem(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listItems = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => itemsService.listItems(t, { itemType: req.query.itemType }));
  return success(res, { data: items });
});
const getItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => itemsService.getItem(req.params.id, t));
  return success(res, { data: item });
});

const createLocation = catchAsync(async (req, res) => {
  const location = await req.withTenantTransaction((t) => itemsService.createLocation(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: location });
});
const listLocations = catchAsync(async (req, res) => {
  const locations = await req.withTenantTransaction((t) => itemsService.listLocations(t));
  return success(res, { data: locations });
});

const recordMovement = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const movement = await req.withTenantTransaction((t) => movementsService.recordMovement(withTenant(req), actor, t));
  return success(res, { statusCode: 201, data: movement });
});
const listBalancesByItem = catchAsync(async (req, res) => {
  const balances = await req.withTenantTransaction((t) => movementsService.listBalancesByItem(req.params.id, t));
  return success(res, { data: balances });
});

const createReceipt = catchAsync(async (req, res) => {
  const receipt = await req.withTenantTransaction((t) => receiptsService.createReceipt(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: receipt });
});
const listReceipts = catchAsync(async (req, res) => {
  const receipts = await req.withTenantTransaction((t) => receiptsService.listReceipts(t, { status: req.query.status }));
  return success(res, { data: receipts });
});
const getReceipt = catchAsync(async (req, res) => {
  const receipt = await req.withTenantTransaction((t) => receiptsService.getReceipt(req.params.id, t));
  return success(res, { data: receipt });
});
const reviewReceipt = catchAsync(async (req, res) => {
  const receipt = await req.withTenantTransaction((t) => receiptsService.reviewReceipt(req.params.id, req.auth.userId, t));
  return success(res, { data: receipt });
});
const confirmReceipt = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const receipt = await req.withTenantTransaction((t) => receiptsService.confirmReceipt(req.params.id, actor, t));
  return success(res, { data: receipt });
});

const createRequisition = catchAsync(async (req, res) => {
  const requisition = await req.withTenantTransaction((t) => requisitionsService.createRequisition(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: requisition });
});
const listRequisitions = catchAsync(async (req, res) => {
  const requisitions = await req.withTenantTransaction((t) => requisitionsService.listRequisitions(t, { status: req.query.status, projectId: req.query.projectId }));
  return success(res, { data: requisitions });
});
const getRequisition = catchAsync(async (req, res) => {
  const requisition = await req.withTenantTransaction((t) => requisitionsService.getRequisition(req.params.id, t));
  return success(res, { data: requisition });
});
const decideRequisition = catchAsync(async (req, res) => {
  const requisition = await req.withTenantTransaction((t) => requisitionsService.decideRequisition(req.params.id, req.body.decision, req.auth.userId, t));
  return success(res, { data: requisition });
});
const issueRequisition = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const requisition = await req.withTenantTransaction((t) => requisitionsService.issueRequisition(req.params.id, actor, t));
  return success(res, { data: requisition });
});

const createAsset = catchAsync(async (req, res) => {
  const asset = await req.withTenantTransaction((t) => assetsService.createAsset(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: asset });
});
const listAssets = catchAsync(async (req, res) => {
  const assets = await req.withTenantTransaction((t) => assetsService.listAssets(t, { status: req.query.status }));
  return success(res, { data: assets });
});
const getAssetByTag = catchAsync(async (req, res) => {
  const asset = await req.withTenantTransaction((t) => assetsService.getAssetByTag(req.params.tag, t));
  return success(res, { data: asset });
});
const transferAsset = catchAsync(async (req, res) => {
  const movement = await req.withTenantTransaction((t) => assetsService.transferAsset(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: movement });
});

const loanTool = catchAsync(async (req, res) => {
  const loan = await req.withTenantTransaction((t) => toolLoansService.loanTool(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: loan });
});
const returnTool = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => toolLoansService.returnTool(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: result });
});
const listToolLoans = catchAsync(async (req, res) => {
  const loans = await req.withTenantTransaction((t) => toolLoansService.listToolLoans(t, { status: req.query.status, assetId: req.query.assetId }));
  return success(res, { data: loans });
});

const openMaintenanceOrder = catchAsync(async (req, res) => {
  const order = await req.withTenantTransaction((t) => maintenanceService.openMaintenanceOrder(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: order });
});
const listMaintenanceOrders = catchAsync(async (req, res) => {
  const orders = await req.withTenantTransaction((t) => maintenanceService.listMaintenanceOrders(t, { status: req.query.status, assetId: req.query.assetId }));
  return success(res, { data: orders });
});
const closeMaintenanceOrder = catchAsync(async (req, res) => {
  const order = await req.withTenantTransaction((t) => maintenanceService.closeMaintenanceOrder(req.params.id, req.auth.userId, t));
  return success(res, { data: order });
});

module.exports = {
  createItem,
  listItems,
  getItem,
  createLocation,
  listLocations,
  recordMovement,
  listBalancesByItem,
  createReceipt,
  listReceipts,
  getReceipt,
  reviewReceipt,
  confirmReceipt,
  createRequisition,
  listRequisitions,
  getRequisition,
  decideRequisition,
  issueRequisition,
  createAsset,
  listAssets,
  getAssetByTag,
  transferAsset,
  loanTool,
  returnTool,
  listToolLoans,
  openMaintenanceOrder,
  listMaintenanceOrders,
  closeMaintenanceOrder,
};
