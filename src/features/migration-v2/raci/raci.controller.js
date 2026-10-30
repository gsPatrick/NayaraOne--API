'use strict';

const { success } = require('../../../utils/httpResponse');
const service = require('./raci.service');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

const getMatrix = async (req, res) => success(res, { data: await req.withTenantTransaction((transaction) => service.getMatrix(tenantFromAuth(req), transaction)) });
const putMatrix = async (req, res) => success(res, {
  data: await req.withTenantTransaction((transaction) => service.replaceActivity(tenantFromAuth(req), { userId: req.auth.userId }, req.body, transaction)),
});

module.exports = { getMatrix, putMatrix };
