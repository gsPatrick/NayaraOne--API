'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { MemoryService } = require('./MemoryService');
const E = require('./memory.errors');

const service = new MemoryService();
const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });
const tx = (req, fn) => req.withTenantTransaction(fn);

const list = catchAsync(async (req, res) => {
  const out = await tx(req, (t) => service.list(ctxDe(req), req.query, t));
  return success(res, { data: out.items, pagination: { page: out.page, limit: out.limit } });
});
const getOne = catchAsync(async (req, res) => success(res, { data: await tx(req, (t) => service.get(ctxDe(req), req.params.id, t)) }));

const create = catchAsync(async (req, res) => {
  const body = { ...(req.body || {}) };
  const key = req.get('Idempotency-Key');
  if (key && body.idempotencyKey === undefined) body.idempotencyKey = key;
  const out = await tx(req, (t) => service.save(ctxDe(req), body, t));
  return success(res, { statusCode: out.replayed ? 200 : 201, data: out.memory, meta: { replayed: out.replayed, piiRemoved: out.piiRemoved } });
});

const invalidate = catchAsync(async (req, res) => {
  const out = await tx(req, (t) => service.invalidate(ctxDe(req), req.params.id, req.body, t));
  return success(res, { data: out.memory, meta: { replayed: out.replayed } });
});

const correct = catchAsync(async (req, res) => {
  const out = await tx(req, (t) => service.correct(ctxDe(req), req.params.id, req.body, t));
  return success(res, { statusCode: 201, data: out.memory, meta: { previousId: out.previous.id, piiRemoved: out.piiRemoved } });
});

const remove = catchAsync(async () => { throw E.deleteForbidden(); });

module.exports = { list, getOne, create, invalidate, correct, remove };
