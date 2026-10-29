'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./policy.service');

const actorFrom = (req) => ({ userId: req.auth.userId });

async function listPolicies(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.listPolicies(tenantFromAuth(req), transaction, { actorUserId: req.auth.userId }));
  return success(res, { data });
}

async function putPolicy(req, res) {
  const { classification, action } = req.params;
  const data = await req.withTenantTransaction((transaction) => service.updatePolicy(tenantFromAuth(req), actorFrom(req), classification, action, req.body, transaction));
  return success(res, { data });
}

module.exports = { listPolicies, putPolicy };
