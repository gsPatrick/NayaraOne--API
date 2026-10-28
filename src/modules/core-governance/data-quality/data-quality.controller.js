'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./data-quality.service');

async function getOverview(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.getOverview(tenantFromAuth(req), transaction));
  return success(res, { data });
}

module.exports = { getOverview };
