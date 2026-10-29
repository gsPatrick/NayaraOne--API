'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { parseListQuery, parseHealthQuery } = require('./admin.query');
const { listIntegrations } = require('./admin.list');
const { getProviderHealth } = require('./admin.health');
const { getDispatchDetail } = require('./admin.dispatch');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });

const list = catchAsync(async (req, res) => {
  const filters = parseListQuery(req.query);
  const data = await req.withTenantTransaction((t) => listIntegrations(ctxDe(req), filters, t));
  return success(res, { data });
});

const health = catchAsync(async (req, res) => {
  const query = parseHealthQuery(req.query);
  const data = await req.withTenantTransaction((t) => getProviderHealth(req.params.provider, query, ctxDe(req), t));
  return success(res, { data });
});

const dispatchDetail = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => getDispatchDetail(req.params.id, ctxDe(req), t));
  return success(res, { data });
});

module.exports = { list, health, dispatchDetail };
