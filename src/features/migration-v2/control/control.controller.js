'use strict';

const { success } = require('../../../utils/httpResponse');
const tower = require('./tower.service');
const resolver = require('./resolve.service');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });
const actorFromAuth = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

const getTower = async (req, res) => success(res, {
  data: await req.withTenantTransaction((transaction) => tower.getTower(tenantFromAuth(req), actorFromAuth(req), { runId: req.query.runId }, transaction)),
});
const resolveRecord = async (req, res) => success(res, {
  data: await req.withTenantTransaction((transaction) => resolver.resolveRecord(tenantFromAuth(req), actorFromAuth(req), req.params.id, req.body, transaction)),
});

module.exports = { getTower, resolveRecord };
