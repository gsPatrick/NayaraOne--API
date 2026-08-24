'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const membershipsService = require('./membership.service');
const effectivePermissionsService = require('./effectivePermissions.service');

const create = catchAsync(async (req, res) => {
  // Defesa em profundidade — mesmo raciocínio de units.controller.js: o tenant do vínculo
  // criado é sempre o do ator autenticado, nunca um valor arbitrário vindo do payload.
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const membership = await req.withTenantTransaction((transaction) =>
    membershipsService.createMembership(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: membership });
});

const list = catchAsync(async (req, res) => {
  const memberships = await req.withTenantTransaction((transaction) =>
    membershipsService.listMemberships({ userId: req.query.userId, companyId: req.query.companyId }, transaction)
  );
  return success(res, { data: memberships });
});

const revoke = catchAsync(async (req, res) => {
  const membership = await req.withTenantTransaction((transaction) =>
    membershipsService.revokeMembership(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: membership });
});

const effectivePermissions = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction(() =>
    effectivePermissionsService.listEffectivePermissions({
      userId: req.params.userId,
      companyId: req.query.companyId || req.auth.companyId,
    })
  );
  return success(res, { data: result });
});

module.exports = { create, list, revoke, effectivePermissions };
