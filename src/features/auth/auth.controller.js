'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const authService = require('./auth.service');

function requestMeta(req) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

const login = catchAsync(async (req, res) => {
  const result = await authService.login(req.body, requestMeta(req));
  return success(res, { statusCode: 200, data: result });
});

const refresh = catchAsync(async (req, res) => {
  const result = await authService.refresh(req.body, requestMeta(req));
  return success(res, { statusCode: 200, data: result });
});

const logout = catchAsync(async (req, res) => {
  const result = await authService.logout(req.body);
  return success(res, { statusCode: 200, data: result });
});

const listCompanies = catchAsync(async (req, res) => {
  const result = await authService.listMyCompanies({ userId: req.auth.userId, currentCompanyId: req.auth.companyId });
  return success(res, { statusCode: 200, data: result });
});

const switchCompany = catchAsync(async (req, res) => {
  const result = await authService.switchCompany(
    { auth: req.auth, companyId: req.body && req.body.companyId },
    requestMeta(req)
  );
  return success(res, { statusCode: 200, data: result });
});

module.exports = { login, refresh, logout, listCompanies, switchCompany };
