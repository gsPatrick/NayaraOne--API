'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./feature-flags.service');

const run = (req, work) => req.withTenantTransaction((transaction) => work(tenantFromAuth(req), transaction));

async function list(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => service.listEntries(tenant, req.query, req.auth.userId, tx)) });
}

async function create(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => service.createEntry(tenant, req.body, req.auth.userId, tx)), statusCode: 201 });
}

async function update(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => service.updateEntry(tenant, req.body, req.auth.userId, tx)) });
}

module.exports = { list, create, update };
