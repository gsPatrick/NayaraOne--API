'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./financingCases.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createFinancingCase = catchAsync(async (req, res) => {
  const financingCase = await req.withTenantTransaction((t) => service.createFinancingCase(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: financingCase });
});

const listFinancingCases = catchAsync(async (req, res) => {
  const cases = await req.withTenantTransaction((t) =>
    service.listFinancingCases(req.auth.groupId, req.auth.companyId, t, { status: req.query.status })
  );
  return success(res, { data: cases });
});

const getFinancingCase = catchAsync(async (req, res) => {
  const financingCase = await req.withTenantTransaction((t) => service.getFinancingCase(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: financingCase });
});

module.exports = { createFinancingCase, listFinancingCases, getFinancingCase };
