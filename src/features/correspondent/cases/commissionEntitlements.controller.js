'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./commissionEntitlements.service');

const createCommissionEntitlement = catchAsync(async (req, res) => {
  const entitlement = await req.withTenantTransaction((t) =>
    service.createCommissionEntitlement(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: entitlement });
});

const confirmCommissionEntitlement = catchAsync(async (req, res) => {
  const entitlement = await req.withTenantTransaction((t) =>
    service.confirmCommissionEntitlement(
      req.params.entitlementId,
      req.body,
      req.auth.userId,
      req.auth.groupId,
      req.auth.companyId,
      t
    )
  );
  return success(res, { data: entitlement });
});

const chargebackCommissionEntitlement = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.chargebackCommissionEntitlement(
      req.params.entitlementId,
      req.body?.reason,
      req.auth.userId,
      req.auth.groupId,
      req.auth.companyId,
      t
    )
  );
  return success(res, { data: result });
});

const listCommissionEntitlements = catchAsync(async (req, res) => {
  const entitlements = await req.withTenantTransaction((t) =>
    service.listCommissionEntitlements(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: entitlements });
});

module.exports = {
  createCommissionEntitlement,
  confirmCommissionEntitlement,
  chargebackCommissionEntitlement,
  listCommissionEntitlements,
};
