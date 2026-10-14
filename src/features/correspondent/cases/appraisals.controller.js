'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./appraisals.service');

const createAppraisal = catchAsync(async (req, res) => {
  const appraisal = await req.withTenantTransaction((t) =>
    service.createAppraisal(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: appraisal });
});

const listAppraisals = catchAsync(async (req, res) => {
  const appraisals = await req.withTenantTransaction((t) =>
    service.listAppraisals(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: appraisals });
});

module.exports = { createAppraisal, listAppraisals };
