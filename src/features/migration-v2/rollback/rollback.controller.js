'use strict';

const { success } = require('../../../utils/httpResponse');
const types = require('./types.service');
const report = require('./report.service');
const items = require('./items.service');
const cutover = require('./cutover.service');

const tenantFromAuth = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });
const actorFromAuth = (req) => ({ userId: req.auth.userId });
const run = (req, fn) => req.withTenantTransaction((transaction) => fn(tenantFromAuth(req), transaction));

const listTypes = async (req, res) => success(res, { data: await run(req, (tenant, tx) => types.listTypes(tenant, tx)) });
const putTypes = async (req, res) => success(res, { data: await run(req, (tenant, tx) => types.putTypes(tenant, actorFromAuth(req), req.body, tx)) });
const getReport = async (req, res) => success(res, { data: await run(req, (tenant, tx) => report.getReport(tenant, req.query, tx)) });
const resolveItem = async (req, res) => success(res, { data: await run(req, (tenant, tx) => items.resolveItem(tenant, actorFromAuth(req), req.params.id, req.body, tx)) });
const decide = async (req, res) => success(res, { data: await run(req, (tenant, tx) => cutover.decide(tenant, actorFromAuth(req), req.body, tx)) });

module.exports = { listTypes, putTypes, getReport, resolveItem, decide };
