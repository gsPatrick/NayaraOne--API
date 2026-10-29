'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./releaseGates.service');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });

const list = catchAsync(async (req, res) => success(res, { data: await req.withTenantTransaction((t) => service.list(ctxDe(req), req.query || {}, t)) }));

const create = catchAsync(async (req, res) => {
  const body = { ...(req.body || {}) };
  const key = req.get('Idempotency-Key');
  if (key && body.idempotencyKey === undefined) body.idempotencyKey = key;
  const out = await req.withTenantTransaction((t) => service.register(ctxDe(req), body, t));
  return success(res, { statusCode: out.replayed ? 200 : 201, data: out.gate, meta: { replayed: out.replayed } });
});

module.exports = { list, create };
