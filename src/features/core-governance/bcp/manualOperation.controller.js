'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./manualOperation.service');

const actor = (req) => ({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId });

async function create(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.recordOperation({ ...actor(req), body: req.body, transaction }));
  return success(res, { statusCode: 201, data });
}

async function update(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.updatePayload({ ...actor(req), id: req.params.id, body: req.body, transaction }));
  return success(res, { data });
}

async function list(req, res) {
  const { items, pagination } = await req.withTenantTransaction((transaction) => service.listOperations({ ...actor(req), query: req.query, transaction }));
  return success(res, { data: items, pagination });
}

module.exports = { create, update, list };
