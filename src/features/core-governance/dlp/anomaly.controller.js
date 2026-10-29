'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const review = require('./anomaly.review');

async function list(req, res) {
  const { items, pagination } = await req.withTenantTransaction((transaction) => review.listAnomalies(tenantFromAuth(req), req.query || {}, transaction));
  return success(res, { data: items, pagination });
}

async function reviewOne(req, res) {
  const data = await req.withTenantTransaction((transaction) => review.reviewAnomaly(tenantFromAuth(req), { userId: req.auth.userId }, req.params.id, req.body, transaction));
  return success(res, { data });
}

module.exports = { list, reviewOne };
