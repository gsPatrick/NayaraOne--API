'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const admin = require('./requirementRulesAdmin.service');

/** Política do checklist documental (regra REG-JUR-001 do Motor de Regras): leitura, histórico e publicação. */
const tenantOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

const getRequirementRules = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => admin.getRequirementRules(tenantOf(req), t));
  return success(res, { data });
});
const listRequirementRuleVersions = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => admin.listRequirementRuleVersions(tenantOf(req), t));
  return success(res, { data });
});
const publishRequirementRules = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => admin.publishRequirementRulesVersion(tenantOf(req), req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data });
});

module.exports = { getRequirementRules, listRequirementRuleVersions, publishRequirementRules };
