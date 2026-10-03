'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const itemsService = require('./items.service');
const movementsService = require('./movements.service');

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

module.exports = {
  createItem,
  listItems,
  getItem,
  createLocation,
  listLocations,
  recordMovement,
  listBalancesByItem,
};
