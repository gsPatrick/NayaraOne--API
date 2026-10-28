'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { listCatalog } = require('./catalog.service');

const listIntegrations = catchAsync(async (req, res) => {
  const ctx = { groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId };
  const data = await req.withTenantTransaction((t) => listCatalog(ctx, t));
  return success(res, { data });
});

module.exports = { listIntegrations };
