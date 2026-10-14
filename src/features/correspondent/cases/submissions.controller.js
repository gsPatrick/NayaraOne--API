'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./submissions.service');

const submitFinancingCase = catchAsync(async (req, res) => {
  const submission = await req.withTenantTransaction((t) =>
    service.submitFinancingCase(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: submission });
});

const listSubmissions = catchAsync(async (req, res) => {
  const submissions = await req.withTenantTransaction((t) =>
    service.listSubmissions(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: submissions });
});

const acknowledgeUnknownSubmission = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.acknowledgeUnknownSubmission(req.params.submissionId, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: result });
});

module.exports = { submitFinancingCase, listSubmissions, acknowledgeUnknownSubmission };
