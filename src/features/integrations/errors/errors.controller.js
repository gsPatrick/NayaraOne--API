'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { listErrors } = require('./errors.list');
const { resolveError } = require('./errors.resolve');
const { serializeError } = require('./errors.serialize');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });

const list = catchAsync(async (req, res) => {
  const { status, source, providerCode, connectionId, limit } = req.query;
  const data = await req.withTenantTransaction((t) => listErrors(ctxDe(req), { status, source, providerCode, connectionId, limit }, t));
  return success(res, { data });
});

const resolve = catchAsync(async (req, res) => {
  const row = await req.withTenantTransaction((t) => resolveError(req.params.id, { note: req.body?.note, outcome: req.body?.outcome }, ctxDe(req), t));
  return success(res, { data: serializeError(row) });
});

module.exports = { list, resolve };
