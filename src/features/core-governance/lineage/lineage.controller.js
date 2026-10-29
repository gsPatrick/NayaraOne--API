'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./lineage.service');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

async function getOverview(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.getOverview(tenantFromAuth(req), transaction));
  return success(res, { data });
}

/** POST cria (201, 409 se existe); PUT grava por tipo + código (200, idempotente). */
const saver = (method, create) => async (req, res) => {
  const data = await req.withTenantTransaction((transaction) => service[method](tenantFromAuth(req), actorFrom(req), req.body, transaction, { create }));
  return success(res, { statusCode: create ? 201 : 200, data });
};

module.exports = { getOverview, createNode: saver('saveNode', true), putNode: saver('saveNode', false), createEdge: saver('saveEdge', true), putEdge: saver('saveEdge', false) };
