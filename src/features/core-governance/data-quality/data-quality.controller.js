'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./data-quality.service');
const stewardship = require('./stewardship.service');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

async function getOverview(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.getOverview(tenantFromAuth(req), transaction));
  return success(res, { data });
}

async function listDomains(req, res) {
  const data = await req.withTenantTransaction((transaction) => stewardship.listDomains(tenantFromAuth(req), transaction));
  return success(res, { data });
}

async function designate(req, res) {
  const data = await req.withTenantTransaction((transaction) => stewardship.designate(tenantFromAuth(req), actorFrom(req), req.params.code, req.body, transaction));
  return success(res, { data });
}

module.exports = { getOverview, listDomains, designate };
