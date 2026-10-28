'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { aiGate } = require('../../aiGate.middleware');
const { anyOf } = require('../../anyOf');
const { getRun } = require('./runReader');

const gate = aiGate({ agentParam: '__sem_agente__' });

const ctxDe = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId, permissions: req.auth.permissions });

const readOne = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => getRun(ctxDe(req), req.params.id, t));
  return success(res, { data });
});

/** GET /v1/ai/runs/:id (ai:read lê o próprio; ai:audit lê todos da empresa). A listagem e os filtros são de M9-D030. */
function registerRunRoutes(router) {
  router.get('/ai/runs/:id', anyOf('ai:read', 'ai:audit'), gate, readOne);
}

module.exports = { registerRunRoutes };
