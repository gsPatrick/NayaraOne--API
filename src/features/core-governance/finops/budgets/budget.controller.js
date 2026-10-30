'use strict';

const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const service = require('./budget.service');

const run = (req, work) => req.withTenantTransaction((transaction) => work(tenantFromAuth(req), transaction));

async function list(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => service.listBudgets(tenant, tx)) });
}

async function create(req, res) {
  const data = await run(req, (tenant, tx) => service.createBudget(tenant, req.body, req.auth.userId, tx));
  return success(res, { statusCode: 201, data });
}

async function update(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => service.updateBudget(tenant, req.params.id, req.body, req.auth.userId, tx)) });
}

module.exports = { list, create, update };
