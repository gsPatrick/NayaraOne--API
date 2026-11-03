'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const service = require('./correspondentNay.service');

const getStalledCases = catchAsync(async (req, res) => {
  const rawThreshold = req.query.thresholdDays;
  let thresholdDays;
  if (rawThreshold !== undefined && rawThreshold !== '') {
    thresholdDays = Number(rawThreshold);
    if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 365) {
      throw AppError.badRequest('Os dias sem atividade precisam ser um número inteiro entre 1 e 365.', 'NAY_VALIDATION');
    }
  }
  const result = await req.withTenantTransaction((t) =>
    service.checkStalledCases(req.auth.groupId, req.auth.companyId, { thresholdDays }, t)
  );
  return success(res, { data: result });
});

const getCompareSimulations = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.compareSimulations(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: result });
});

const getCaseSummary = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.summarizeCase(req.params.id, req.auth.groupId, req.auth.companyId, t, { canSeeCommission: ['finance:read', 'correspondent:fiscal', 'correspondent:parameters'].some((p) => (req.auth.permissions || []).includes(p)) })
  );
  return success(res, { data: result });
});

module.exports = { getStalledCases, getCompareSimulations, getCaseSummary };
