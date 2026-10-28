'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../marketing.module');
const service = require('./campaigns.service');

async function create(req, res) {
  const out = await req.withTenantTransaction((t) => service.saveCampaign(tenantFromAuth(req), req.auth.userId, req.body, { permissions: req.auth.permissions }, t));
  return success(res, { statusCode: out.created ? 201 : 200, data: out.campaign });
}

async function get(req, res) {
  const data = await req.withTenantTransaction((t) => service.getCampaign(tenantFromAuth(req), req.params.id, t));
  return success(res, { data });
}

module.exports = { create, get };
