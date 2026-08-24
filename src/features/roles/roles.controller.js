'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const rolesService = require('./roles.service');

const create = catchAsync(async (req, res) => {
  // Defesa em profundidade — tenant do papel criado é sempre o do ator autenticado.
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const role = await req.withTenantTransaction((transaction) => rolesService.createRole(payload, req.auth.userId, transaction));
  return success(res, { statusCode: 201, data: role });
});

const list = catchAsync(async (req, res) => {
  const roles = await req.withTenantTransaction((transaction) =>
    rolesService.listRoles(transaction, { companyId: req.query.companyId || req.auth.companyId })
  );
  return success(res, { data: roles });
});

const getOne = catchAsync(async (req, res) => {
  const role = await req.withTenantTransaction((transaction) => rolesService.getRole(req.params.id, transaction));
  return success(res, { data: role });
});

const update = catchAsync(async (req, res) => {
  const role = await req.withTenantTransaction((transaction) =>
    rolesService.updateRole(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: role });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) => rolesService.removeRole(req.params.id, req.auth.userId, transaction));
  return success(res, { data: result });
});

const listPermissions = catchAsync(async (req, res) => {
  const permissions = await req.withTenantTransaction((transaction) => rolesService.listPermissionsCatalog(transaction));
  return success(res, { data: permissions });
});

module.exports = { create, list, getOne, update, remove, listPermissions };
