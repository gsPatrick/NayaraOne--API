'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const service = require('./providerAccounts.service');

const registerProviderAccount = catchAsync(async (req, res) => {
  const account = await req.withTenantTransaction((t) => service.registerProviderAccount(
    { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId },
    req.auth.userId,
    t
  ));
  return success(res, { statusCode: 201, data: account });
});

const listProviderAccounts = catchAsync(async (req, res) => {
  const accounts = await req.withTenantTransaction((t) => service.listProviderAccounts(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: accounts });
});

const updateProviderAccount = catchAsync(async (req, res) => {
  const account = await req.withTenantTransaction((t) => service.updateProviderAccount(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: account });
});

module.exports = { registerProviderAccount, listProviderAccounts, updateProviderAccount };
