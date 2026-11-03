'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const duplicates = require('./correspondentDuplicate.service');
const integrationErrors = require('./integrationErrors.service');

const listPendingDuplicates = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => duplicates.listPendingDuplicateReviews(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data });
});

const reviewDuplicate = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    duplicates.reviewDuplicate(req.params.id, req.body || {}, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

const listIntegrationErrors = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    integrationErrors.listIntegrationErrors({ status: req.query.status, limit: req.query.limit }, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

const resolveIntegrationError = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    integrationErrors.resolveIntegrationError(req.params.id, req.body?.note, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

module.exports = { listPendingDuplicates, reviewDuplicate, listIntegrationErrors, resolveIntegrationError };
