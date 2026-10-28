'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./commitments.service');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

async function create(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.createCommitment(tenantFromAuth(req), actorFrom(req), req.body, transaction));
  return success(res, { statusCode: 201, data });
}

async function get(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.getCommitment(tenantFromAuth(req), req.params.id, transaction));
  return success(res, { data });
}

async function patch(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.updateCommitment(tenantFromAuth(req), actorFrom(req), req.params.id, req.body, transaction));
  return success(res, { data });
}

module.exports = { create, get, patch };
