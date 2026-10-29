'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./policy.service');
const { parsePagination, pageOfArray } = require('../api-governance/standards/pagination.helper');

const actorFrom = (req) => ({ userId: req.auth.userId });

async function listPolicies(req, res) {
  const { items, pagination } = await req.withTenantTransaction(async (transaction) => {
    const tenant = tenantFromAuth(req);
    return pageOfArray(await service.listPolicies(tenant, transaction, { actorUserId: req.auth.userId }), await parsePagination(req.query, tenant, transaction));
  });
  return success(res, { data: items, pagination });
}

async function putPolicy(req, res) {
  const { classification, action } = req.params;
  const data = await req.withTenantTransaction((transaction) => service.updatePolicy(tenantFromAuth(req), actorFrom(req), classification, action, req.body, transaction));
  return success(res, { data });
}

module.exports = { listPolicies, putPolicy };
