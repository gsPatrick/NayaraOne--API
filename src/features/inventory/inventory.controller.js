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
const lossCasesService = require('./lossCases.service');
const countsService = require('./counts.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => itemsService.createItem(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listItems = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => itemsService.listItems(t, { itemType: req.query.itemType, status: req.query.status }));
  return success(res, { data: items });
});
const setItemStatus = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => itemsService.setItemStatus(req.params.id, req.body.status, req.auth.userId, t));
  return success(res, { data: item });
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
const updateAsset = catchAsync(async (req, res) => {
  const asset = await req.withTenantTransaction((t) => assetsService.updateAsset(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: asset });
});
const transferAsset = catchAsync(async (req, res) => {
  const movement = await req.withTenantTransaction((t) => assetsService.transferAsset(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: movement });
});

const listAssetMovements = catchAsync(async (req, res) => {
  const movements = await req.withTenantTransaction((t) => assetsService.listAssetMovements(req.params.id, t));
  return success(res, { data: movements });
});

const disposeAsset = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const result = await req.withTenantTransaction((t) => assetsService.disposeAsset(req.params.id, req.body, actor, t));
  return success(res, { statusCode: 201, data: result });
});
const getAssetDisposal = catchAsync(async (req, res) => {
  const disposal = await req.withTenantTransaction((t) => assetsService.getAssetDisposal(req.params.id, t));
  return success(res, { data: disposal });
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

const openLossCase = catchAsync(async (req, res) => {
  const lossCase = await req.withTenantTransaction((t) => lossCasesService.openLossCase(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: lossCase });
});
const listLossCases = catchAsync(async (req, res) => {
  const lossCases = await req.withTenantTransaction((t) => lossCasesService.listLossCases(t, { status: req.query.status }));
  return success(res, { data: lossCases });
});
const decideLossCase = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const lossCase = await req.withTenantTransaction((t) => lossCasesService.decideLossCase(req.params.id, req.body.decision, actor, t));
  return success(res, { data: lossCase });
});

const openCount = catchAsync(async (req, res) => {
  const count = await req.withTenantTransaction((t) => countsService.openCount(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: count });
});
const listCounts = catchAsync(async (req, res) => {
  const counts = await req.withTenantTransaction((t) => countsService.listCounts(t, { status: req.query.status }));
  return success(res, { data: counts });
});
const getCount = catchAsync(async (req, res) => {
  const count = await req.withTenantTransaction((t) => countsService.getCount(req.params.id, t));
  return success(res, { data: count });
});
const addCountItem = catchAsync(async (req, res) => {
  const line = await req.withTenantTransaction((t) => countsService.addCountItem(req.params.id, req.body, t));
  return success(res, { statusCode: 201, data: line });
});
const completeCount = catchAsync(async (req, res) => {
  const count = await req.withTenantTransaction((t) => countsService.completeCount(req.params.id, req.auth.userId, t));
  return success(res, { data: count });
});
const applyCountAdjustment = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId, canApprove: req.auth.permissions?.includes('inventory:approve') };
  const line = await req.withTenantTransaction((t) => countsService.applyAdjustment(req.params.countItemId, actor, t));
  return success(res, { data: line });
});

module.exports = {
  createItem,
  listItems,
  getItem,
  setItemStatus,
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
  updateAsset,
  getAssetByTag,
  transferAsset,
  listAssetMovements,
  disposeAsset,
  getAssetDisposal,
  loanTool,
  returnTool,
  listToolLoans,
  openMaintenanceOrder,
  listMaintenanceOrders,
  closeMaintenanceOrder,
  openLossCase,
  listLossCases,
  decideLossCase,
  openCount,
  listCounts,
  getCount,
  addCountItem,
  completeCount,
  applyCountAdjustment,
};
