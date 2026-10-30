'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { requirePermission } = require('../../../middlewares/auth.middleware');
const { ENTRIES } = require('./deterministic.catalog');
const { runDeterministic } = require('./deterministic.run');
const { resolveAiMode } = require('./deterministic.mode');

const authOf = (req) => ({ userId: req.auth.userId, groupId: req.auth.groupId, companyId: req.auth.companyId, permissions: req.auth.permissions || [], roles: req.auth.roles || [] });

/**
 * Funções determinísticas da NAY (M9-D228): GET /ai/deterministic (modo atual da IA e o caminho de cada função) e POST /ai/deterministic/:tool (roda o equivalente determinístico, que não
 * depende de modelo e por isso NÃO passa pela chave geral da IA). A permissão da própria tool é conferida dentro do serviço.
 */
function registerDeterministicRoutes(router) {
  router.get('/ai/deterministic', requirePermission('ai:read'), catchAsync(async (req, res) => {
    const mode = await req.withTenantTransaction((t) => resolveAiMode(authOf(req), t));
    return success(res, { data: { mode, functions: Object.entries(ENTRIES).map(([id, e]) => ({ id, kind: e.kind, equivalent: e.equivalent })) } });
  }));
  router.post('/ai/deterministic/:tool', requirePermission('ai:read'), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((t) => runDeterministic(authOf(req), req.params.tool, req.body && req.body.input, t));
    return success(res, { data });
  }));
}

module.exports = { registerDeterministicRoutes };
