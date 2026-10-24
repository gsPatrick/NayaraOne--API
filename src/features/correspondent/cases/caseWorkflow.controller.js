'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const workflowService = require('./caseWorkflow.service');

const registerManualStatus = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    workflowService.registerManualStatus(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: { status: result.financingCase.status, proposal: result.proposal } });
});

const cancelCase = catchAsync(async (req, res) => {
  const financingCase = await req.withTenantTransaction((t) =>
    workflowService.cancelCase(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: { status: financingCase.status } });
});

const listProposals = catchAsync(async (req, res) => {
  const proposals = await req.withTenantTransaction((t) =>
    workflowService.listProposals(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: proposals });
});

module.exports = { registerManualStatus, cancelCase, listProposals };
