'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./merge.service');
const { impactOf } = require('./merge.impact');
const { STATUS } = require('./merge.constants');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });

async function listQueue(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.listQueue(tenantFromAuth(req), req.query, transaction));
  return success(res, { data });
}

async function impact(req, res) {
  const survivorId = typeof req.query.survivorId === 'string' ? req.query.survivorId.toLowerCase() : null;
  const data = await req.withTenantTransaction((transaction) => impactOf(tenantFromAuth(req), req.params.id, survivorId, transaction));
  return success(res, { data });
}

/** Unir cadastros é ação crítica (linha 8 da M9-D852, MFA sim): a decisão MERGED exige MFA recente; as demais não. */
async function decide(req, res) {
  if (req.body && typeof req.body.decision === 'string' && req.body.decision.trim().toUpperCase() === STATUS.MERGED) {
    const { assertRecentMfa } = require('../../users/mfa.service');
    await req.withTenantTransaction((transaction) => assertRecentMfa(req.auth.userId, transaction));
  }
  const data = await req.withTenantTransaction((transaction) => service.decide(tenantFromAuth(req), actorFrom(req), req.params.id, req.body, transaction));
  return success(res, { data });
}

module.exports = { listQueue, impact, decide };
