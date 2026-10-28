'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const registry = require('./knowledgeRegistry.service');
const lifecycle = require('./knowledgeLifecycle.service');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });
const tx = (req, fn) => req.withTenantTransaction(fn);

const list = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => registry.listEntries(ctxDe(req), req.query, t)) }));
const getOne = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => registry.getEntry(ctxDe(req), req.params.id, t)) }));
const create = catchAsync(async (req, res) => success(res, { statusCode: 201, data: await tx(req, (t) => registry.createEntry(ctxDe(req), req.body, t)) }));
const update = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => registry.updateDraft(ctxDe(req), req.params.id, req.body, t)) }));
const homologate = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => lifecycle.homologate(ctxDe(req), req.params.id, t)) }));
const revoke = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => lifecycle.revoke(ctxDe(req), req.params.id, req.body, t)) }));

module.exports = { list, getOne, create, update, homologate, revoke };
