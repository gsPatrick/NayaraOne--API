'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./classification.service');
const { buildPagination } = require('../api-governance/standards/pagination.helper');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });
const tenantOf = (req) => ({ ...tenantFromAuth(req), userId: req.auth.userId });

async function list(req, res) {
  const result = await req.withTenantTransaction((tx) => service.listRegistry(tenantOf(req), req.query, tx));
  return success(res, { data: result.items, pagination: buildPagination(result) });
}

async function put(req, res) {
  const result = await req.withTenantTransaction((tx) => service.putEntry(tenantOf(req), actorFrom(req), req.body, tx));
  return success(res, { data: result.entry, meta: { changed: result.changed } });
}

async function legacyReview(req, res) {
  const result = await req.withTenantTransaction((tx) => service.listLegacyReview(tenantOf(req), req.query, tx));
  return success(res, { data: result.items, pagination: buildPagination(result) });
}

module.exports = { list, put, legacyReview };
