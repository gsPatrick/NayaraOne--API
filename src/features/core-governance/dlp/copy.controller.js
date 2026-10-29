'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const copy = require('./copy.service');

async function createCopyEvent(req, res) {
  const actor = { userId: req.auth.userId, permissions: req.auth.permissions };
  const data = await req.withTenantTransaction((transaction) => copy.recordCopyEvent(tenantFromAuth(req), actor, req.body, req.ip, transaction));
  return success(res, { statusCode: 201, data });
}

module.exports = { createCopyEvent };
