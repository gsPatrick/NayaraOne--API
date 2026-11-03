'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const service = require('./parameters.service');

const getParameters = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => service.getParameters(req.auth.groupId, req.auth.companyId, req.auth.userId, t));
  return success(res, { data });
});

const updateEligibility = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    service.updateEligibility(req.body?.config, req.body?.reason, req.auth.userId, req.auth.groupId, req.auth.companyId, t, { expectedVersionId: req.body?.baseVersionId })
  );
  return success(res, { data });
});

const updateCommission = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    service.updateCommission(req.body?.config, req.body?.reason, req.auth.userId, req.auth.groupId, req.auth.companyId, t, { expectedVersionId: req.body?.baseVersionId })
  );
  return success(res, { data });
});

module.exports = { getParameters, updateEligibility, updateCommission };
