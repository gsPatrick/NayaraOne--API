'use strict';

const { success } = require('../../../utils/httpResponse');
const service = require('./canary.service');

const tenantOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });

const advance = async (req, res) => success(res, { data: await req.withTenantTransaction((tx) => service.advance(tenantOf(req), req.params.sector, req.body, tx)) });
const rollback = async (req, res) => success(res, { data: await req.withTenantTransaction((tx) => service.rollback(tenantOf(req), req.params.sector, req.body, tx)) });
const status = async (req, res) => success(res, { data: await req.withTenantTransaction((tx) => service.status(tenantOf(req), tx)) });

module.exports = { advance, rollback, status };
