'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./registry.service');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });

const listProviders = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => service.listProviders({ domain: req.query.domain, status: req.query.status }, t));
  return success(res, { data });
});

const createProvider = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => service.createProvider(req.body, ctxDe(req), t));
  return success(res, { statusCode: 201, data });
});

const updateProvider = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => service.updateProvider(req.params.code, req.body, ctxDe(req), t));
  return success(res, { data });
});

const listConnections = catchAsync(async (req, res) => {
  const { environment, domain, status, providerCode } = req.query;
  const rows = await req.withTenantTransaction((t) => service.listConnections(ctxDe(req), { environment, domain, status, providerCode }, t));
  return success(res, { data: rows.map(service.serializeConnection) });
});

const getConnection = catchAsync(async (req, res) => {
  const row = await req.withTenantTransaction((t) => service.getConnection(req.params.id, ctxDe(req), t));
  return success(res, { data: service.serializeConnection(row) });
});

const createConnection = catchAsync(async (req, res) => {
  const row = await req.withTenantTransaction((t) => service.createConnection(req.body, ctxDe(req), t));
  return success(res, { statusCode: 201, data: service.serializeConnection(row) });
});

const updateConnection = catchAsync(async (req, res) => {
  const row = await req.withTenantTransaction((t) => service.updateConnection(req.params.id, req.body, ctxDe(req), t));
  return success(res, { data: service.serializeConnection(row) });
});

const transitionConnection = catchAsync(async (req, res) => {
  const row = await req.withTenantTransaction((t) => service.transitionConnection(req.params.id, req.body?.status, ctxDe(req), t));
  return success(res, { data: service.serializeConnection(row) });
});

// M9-D221: troca de fornecedor da mesma família (a integração da rota sai de cena em drenagem; a do corpo entra).
const swapConnection = catchAsync(async (req, res) => {
  const { swapProvider } = require('../swap');
  const r = await req.withTenantTransaction((t) => swapProvider(ctxDe(req), { fromConnectionId: req.params.id, toConnectionId: req.body?.toConnectionId }, t));
  return success(res, { data: { from: service.serializeConnection(r.from), to: service.serializeConnection(r.to) } });
});

module.exports = { swapConnection, listProviders, createProvider, updateProvider, listConnections, getConnection, createConnection, updateConnection, transitionConnection };
