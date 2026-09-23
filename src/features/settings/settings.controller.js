'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const settingsService = require('./settings.service');

function tenantFromAuth(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const listSettings = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    settingsService.listSettingsByPrefix(req.query.prefix, tenantFromAuth(req), t)
  );
  return success(res, { data: items });
});

const getSetting = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => settingsService.getSettingRow(req.params.key, tenantFromAuth(req), t));
  return success(res, { data: item });
});

const upsertSetting = catchAsync(async (req, res) => {
  if (req.body.value === undefined) {
    throw AppError.badRequest('O campo "value" é obrigatório.', 'SETTING_VALIDATION');
  }
  const item = await req.withTenantTransaction((t) =>
    settingsService.upsertSetting(req.params.key, req.body.value, tenantFromAuth(req), req.auth.userId, t)
  );
  return success(res, { data: item });
});

const getIntegrationsStatus = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => settingsService.getIntegrationsStatus(tenantFromAuth(req), t));
  return success(res, { data });
});

module.exports = { listSettings, getSetting, upsertSetting, getIntegrationsStatus };
