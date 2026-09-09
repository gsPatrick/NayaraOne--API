'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const mfaService = require('./mfa.service');

const setup = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => mfaService.setupMfa(req.auth.userId, req.auth, t));
  return success(res, { data: result });
});

const confirm = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => mfaService.confirmMfa(req.auth.userId, req.body.code, req.auth, t));
  return success(res, { data: result });
});

const verify = catchAsync(async (req, res) => {
  const requestMeta = { ip: req.ip, userAgent: req.headers['user-agent'] };
  const result = await req.withTenantTransaction((t) => mfaService.verifyMfa(req.auth.userId, req.body.code, req.auth, t, requestMeta));
  return success(res, { data: result });
});

const disable = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => mfaService.disableMfa(req.auth.userId, req.body.code, req.auth, t));
  return success(res, { data: result });
});

module.exports = { setup, confirm, verify, disable };
