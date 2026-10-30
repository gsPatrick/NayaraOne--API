'use strict';

const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const policies = require('./policy.service');

const run = (req, work) => req.withTenantTransaction((transaction) => work(tenantFromAuth(req), transaction));

async function list(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => policies.listPolicies(tenant, tx)) });
}

async function save(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => policies.putPolicy(tenant, req.body, req.auth.userId, tx)) });
}

module.exports = { list, save };
