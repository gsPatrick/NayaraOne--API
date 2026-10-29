'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./data-quality.service');
const stewardship = require('./stewardship.service');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

/** GET /data-quality (M9-D806): `{summary, items}` em data e a paginação ao lado. */
async function getOverview(req, res) {
  const result = await req.withTenantTransaction((transaction) => service.getDataQuality(tenantFromAuth(req), req.query, transaction));
  const { page, pageSize, total } = result;
  return success(res, { data: { summary: result.summary, items: result.items }, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
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
