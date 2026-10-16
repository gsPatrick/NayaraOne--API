'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./caseDocuments.service');

function tenant(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createRequirement = catchAsync(async (req, res) => {
  const requirement = await req.withTenantTransaction((t) =>
    service.createRequirement(req.params.id, req.body, req.auth.userId, tenant(req), t)
  );
  return success(res, { statusCode: 201, data: requirement });
});

const listRequirements = catchAsync(async (req, res) => {
  const canSeeDocuments = req.auth.permissions.includes('correspondent:documents:read');
  const requirements = await req.withTenantTransaction((t) =>
    service.listRequirements(req.params.id, tenant(req), t, { canSeeDocuments })
  );
  return success(res, { data: requirements });
});

const uploadDocument = catchAsync(async (req, res) => {
  const { requirementId, ...rest } = req.body || {};
  const document = await req.withTenantTransaction((t) =>
    service.uploadDocument(req.params.id, requirementId, rest, req.auth.userId, tenant(req), t)
  );
  return success(res, { statusCode: 201, data: document });
});

module.exports = { createRequirement, listRequirements, uploadDocument };
