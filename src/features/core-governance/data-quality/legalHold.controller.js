'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./legalHold.service');
const { buildPagination } = require('../api-governance/standards/pagination.helper');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });
const tenantOf = (req) => ({ ...tenantFromAuth(req), userId: req.auth.userId });

async function create(req, res) {
  const data = await req.withTenantTransaction((tx) => service.create(tenantOf(req), actorFrom(req), req.body, tx));
  return success(res, { data, statusCode: 201 });
}

async function list(req, res) {
  const result = await req.withTenantTransaction((tx) => service.list(tenantOf(req), req.query, tx));
  return success(res, { data: result.items, pagination: buildPagination(result) });
}

async function get(req, res) {
  return success(res, { data: await req.withTenantTransaction((tx) => service.get(tenantOf(req), req.params.id, tx)) });
}

async function release(req, res) {
  // A justificativa confirmada na ConfirmAction (nível 3) é o motivo da liberação quando o corpo não traz `release_reason`.
  const input = { ...(req.body || {}) };
  if (!input.release_reason && req.confirmation && req.confirmation.justification) input.release_reason = req.confirmation.justification;
  const data = await req.withTenantTransaction((tx) => service.release(tenantOf(req), actorFrom(req), req.params.id, input, tx));
  return success(res, { data });
}

module.exports = { create, list, get, release };
