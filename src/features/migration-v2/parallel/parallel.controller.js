'use strict';

const { success } = require('../../../utils/httpResponse');
const service = require('./window.service');
const report = require('./report.service');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

const createWindow = async (req, res) => success(res, {
  statusCode: 201, data: await req.withTenantTransaction((transaction) => service.createWindow(tenantFromAuth(req), { userId: req.auth.userId }, req.body, transaction)),
});
const getWindow = async (req, res) => success(res, {
  data: await req.withTenantTransaction((transaction) => report.windowReport(tenantFromAuth(req), req.params.id, { limit: req.query.limit }, transaction)),
});

module.exports = { createWindow, getWindow };
