'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const service = require('./correspondentNay.service');

const getStalledCases = catchAsync(async (req, res) => {
  const thresholdDays = req.query.thresholdDays ? Number(req.query.thresholdDays) : undefined;
  const result = await req.withTenantTransaction((t) =>
    service.checkStalledCases(req.auth.groupId, req.auth.companyId, { thresholdDays }, t)
  );
  return success(res, { data: result });
});

const getCompareSimulations = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.compareSimulations(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: result });
});

const getCaseSummary = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.summarizeCase(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: result });
});

module.exports = { getStalledCases, getCompareSimulations, getCaseSummary };
