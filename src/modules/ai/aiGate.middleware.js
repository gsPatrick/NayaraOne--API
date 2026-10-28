'use strict';

const catchAsync = require('../../utils/catchAsync');
const { getSetting } = require('../../features/settings/settings.service');
const {
  AI_ENABLED_KEY, AI_AGENTS_ENABLED_KEY, AI_SETTING_DEFAULTS, parseAgentList,
} = require('./ai.settings');
const { aiFeatureDisabled, aiAgentDisabled } = require('./ai.errors');

function tenantFromAuth(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

/** A chave geral da NAY está ligada para a empresa? Fail-closed: só `true` liga; ausente, nulo ou inválido = desligada. */
async function isAiEnabled(tenant, transaction) {
  const value = await getSetting(AI_ENABLED_KEY, tenant, transaction, AI_SETTING_DEFAULTS[AI_ENABLED_KEY]);
  return value === true;
}

/** O agente está habilitado na empresa? (`ai.agents.enabled`: "*" ou lista de códigos.) */
async function isAgentEnabled(agentCode, tenant, transaction) {
  const raw = await getSetting(AI_AGENTS_ENABLED_KEY, tenant, transaction, AI_SETTING_DEFAULTS[AI_AGENTS_ENABLED_KEY]);
  const list = parseAgentList(raw);
  return list.all || list.codes.has(String(agentCode).trim().toUpperCase());
}

/**
 * aiGate — vem DEPOIS de authMiddleware, tenantMiddleware e requirePermission (ordem do livro). Chave geral desligada: 503
 * AI_FEATURE_DISABLED. Rota com :code de agente e agente fora de `ai.agents.enabled`: 409 AI_AGENT_DISABLED.
 */
function aiGate(options = {}) {
  const agentParam = options.agentParam || 'code';
  return catchAsync(async (req, res, next) => {
    const tenant = tenantFromAuth(req);
    const agentCode = req.params[agentParam];
    await req.withTenantTransaction(async (transaction) => {
      if (!(await isAiEnabled(tenant, transaction))) throw aiFeatureDisabled();
      if (agentCode && !(await isAgentEnabled(agentCode, tenant, transaction))) throw aiAgentDisabled(agentCode);
    });
    return next();
  });
}

module.exports = { aiGate, isAiEnabled, isAgentEnabled };
