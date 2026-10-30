'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../marketing.module');
const service = require('./template.service');
const { assertKnownBodyFields } = require('../marketing.body');

async function create(req, res) {
  const data = await req.withTenantTransaction((t) => service.createTemplate(tenantFromAuth(req), req.auth.userId, req.body, t));
  return success(res, { statusCode: 201, data });
}

async function list(req, res) {
  const data = await req.withTenantTransaction((t) => service.listTemplates(tenantFromAuth(req), req.query, t));
  return success(res, { data });
}

async function publish(req, res) {
  assertKnownBodyFields(req.body, []); // M9-D435: a publicação não recebe campo nenhum
  const data = await req.withTenantTransaction((t) => service.publishTemplate(tenantFromAuth(req), req.auth.userId, req.params.id, t));
  return success(res, { data });
}

module.exports = { create, list, publish };
