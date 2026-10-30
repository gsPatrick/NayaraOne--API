'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./finops.service');

async function getOverview(req, res) {
  const includeShared = (req.auth.permissions || []).includes('governance:finops:manage') || (req.auth.roles || []).includes('ADMIN');
  const data = await req.withTenantTransaction((transaction) => service.getOverview(tenantFromAuth(req), transaction, { includeShared }));
  return success(res, { data });
}

module.exports = { getOverview };
