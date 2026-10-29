'use strict';

const { buildPagination, parsePagination, pageOfArray } = require('../api-governance/standards/pagination.helper');
const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./data-quality.service');
const stewardship = require('./stewardship.service');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

/** GET /data-quality (M9-D806): `{summary, items}` em data e a paginação ao lado. */
async function getOverview(req, res) {
  const result = await req.withTenantTransaction((transaction) => service.getDataQuality(tenantFromAuth(req), req.query, transaction));
  const { page, pageSize, total } = result;
  return success(res, { data: { summary: result.summary, items: result.items }, pagination: buildPagination({ page, pageSize, total }) });
}

async function listDomains(req, res) {
  const { items, pagination } = await req.withTenantTransaction(async (transaction) => {
    const tenant = tenantFromAuth(req);
    return pageOfArray(await stewardship.listDomains(tenant, transaction), await parsePagination(req.query, tenant, transaction));
  });
  return success(res, { data: items, pagination });
}

async function designate(req, res) {
  const data = await req.withTenantTransaction((transaction) => stewardship.designate(tenantFromAuth(req), actorFrom(req), req.params.code, req.body, transaction));
  return success(res, { data });
}

module.exports = { getOverview, listDomains, designate };
