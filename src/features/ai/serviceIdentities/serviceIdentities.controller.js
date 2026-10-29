'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./serviceIdentities.service');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });
const tx = (req, fn) => req.withTenantTransaction(fn);

const list = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => service.listServiceIdentities(ctxDe(req), t)) }));
const create = catchAsync(async (req, res) => success(res, { statusCode: 201, data: await tx(req, (t) => service.createServiceIdentity(ctxDe(req), req.body, t)) }));
const update = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => service.updateServiceIdentity(ctxDe(req), req.params.id, req.body, t)) }));

module.exports = { list, create, update };
