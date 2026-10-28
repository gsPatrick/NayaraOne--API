'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { getSetting } = require('../../features/settings/settings.service');
const { aiGate } = require('./aiGate.middleware');
const { aiNotAvailable } = require('./ai.errors');
const { AI_AGENTS_ENABLED_KEY, AI_SETTING_DEFAULTS, parseAgentList } = require('./ai.settings');

/**
 * Rotas da NAY, montadas em /v1/ai/*. Ordem em toda rota: authMiddleware -> tenantMiddleware -> requirePermission -> aiGate -> handler.
 * Auth e tenant valem só sob /ai (nunca router.use sem caminho, que interceptaria o resto de /v1).
 * O conteúdo de runs e chat é de M9-D004 em diante: até lá os handlers respondem 501 AI_NOT_AVAILABLE (depois do gate).
 */
const router = Router();
router.use('/ai', authMiddleware, tenantMiddleware);

router.get('/ai/status', requirePermission('ai:read'), aiGate(), catchAsync(async (req, res) => {
  const raw = await req.withTenantTransaction((transaction) => getSetting(
    AI_AGENTS_ENABLED_KEY, { groupId: req.auth.groupId, companyId: req.auth.companyId }, transaction, AI_SETTING_DEFAULTS[AI_AGENTS_ENABLED_KEY]
  ));
  const list = parseAgentList(raw);
  return success(res, { data: { habilitada: true, agentes: list.all ? '*' : [...list.codes] } });
}));

router.post('/ai/runs', requirePermission('ai:use'), aiGate(), (req, res, next) => next(aiNotAvailable('runs')));
router.post('/ai/agents/:code/chat', requirePermission('ai:use'), aiGate(), (req, res, next) => next(aiNotAvailable('chat')));

module.exports = router;
