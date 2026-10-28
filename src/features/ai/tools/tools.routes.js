'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { requirePermission } = require('../../../middlewares/auth.middleware');
const { aiGate } = require('../aiGate.middleware');
const { initToolRegistry } = require('./bootRegistry');

/** Visão administrativa de uma tool: tudo da definição, menos a função `execute`. */
const toView = (def) => ({
  name: def.name, version: def.version, description: def.description, permissionCode: def.permissionCode, riskLevel: def.riskLevel,
  category: def.category, domain: def.domain, requiresHumanApproval: def.requiresHumanApproval, idempotent: def.idempotent,
  inputSchema: def.inputSchema, outputSchema: def.outputSchema,
});

/** GET /v1/ai/tools — catálogo das tools registradas no servidor (só quem administra a NAY). */
function registerToolRoutes(router) {
  router.get('/ai/tools', requirePermission('ai:admin'), aiGate({ agentParam: '__sem_agente__' }), catchAsync(async (req, res) => {
    const registry = await initToolRegistry();
    return success(res, { data: registry.list().map(toView) });
  }));
}

module.exports = { registerToolRoutes, toView };
