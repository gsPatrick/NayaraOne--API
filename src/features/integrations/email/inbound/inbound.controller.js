'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { listInboundMessages, getInboundMessage, linkInboundMessage } = require('./inbound.read');

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId });
/** O perfil autorizado a ver mensagem com dado pessoal é o de quem administra as integrações. */
const canReadPii = (req) => req.auth.permissions.includes('integration:manage');

const list = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listInboundMessages(ctxDe(req), { canReadPii: canReadPii(req), linkStatus: req.query.linkStatus, limit: req.query.limit }, t));
  return success(res, { data });
});

const detail = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => getInboundMessage(ctxDe(req), req.params.id, { canReadPii: canReadPii(req) }, t));
  return success(res, { data });
});

const link = catchAsync(async (req, res) => {
  const body = req.body || {};
  const data = await req.withTenantTransaction((t) => linkInboundMessage(ctxDe(req), req.params.id, { entityType: body.entityType, entityId: body.entityId, canReadPii: canReadPii(req) }, t));
  return success(res, { data });
});

module.exports = { list, detail, link };
