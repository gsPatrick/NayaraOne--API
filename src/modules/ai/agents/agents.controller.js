'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const registry = require('./agentRegistry.service');
const lifecycle = require('./agentLifecycle.service');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });
const tx = (req, fn) => req.withTenantTransaction(fn);

const listActive = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => registry.listActiveAgents(ctxDe(req), t));
  return success(res, { data });
});

const listVersions = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => registry.listVersions(ctxDe(req), req.params.code, t));
  return success(res, { data });
});

const getVersion = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => registry.getVersion(ctxDe(req), req.params.code, req.params.version, t));
  return success(res, { data });
});

const createVersion = catchAsync(async (req, res) => {
  const body = { ...(req.body || {}) };
  if (body.idempotencyKey === undefined && req.get('Idempotency-Key')) body.idempotencyKey = req.get('Idempotency-Key');
  const data = await tx(req, (t) => registry.createVersion(ctxDe(req), req.params.code, body, t));
  return success(res, { statusCode: data.replay ? 200 : 201, data });
});

const updateDraft = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => registry.updateDraft(ctxDe(req), req.params.code, req.params.version, req.body, t));
  return success(res, { data });
});

const setTools = catchAsync(async (req, res) => {
  const tools = Array.isArray(req.body) ? req.body : (req.body || {}).tools;
  const data = await tx(req, (t) => registry.setTools(ctxDe(req), req.params.code, req.params.version, tools, t));
  return success(res, { data });
});

const homologate = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => lifecycle.homologate(ctxDe(req), req.params.code, req.params.version, req.body || {}, t));
  return success(res, { data });
});

const activate = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => lifecycle.activate(ctxDe(req), req.params.code, req.params.version, t));
  return success(res, { data });
});

const retire = catchAsync(async (req, res) => {
  const data = await tx(req, (t) => lifecycle.retire(ctxDe(req), req.params.code, req.params.version, t));
  return success(res, { data });
});

module.exports = { listActive, listVersions, getVersion, createVersion, updateDraft, setTools, homologate, activate, retire };
