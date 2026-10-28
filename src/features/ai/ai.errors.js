'use strict';

const AppError = require('../../utils/AppError');

function aiFeatureDisabled() {
  return new AppError('A NAY está desativada para esta empresa.', 503, 'AI_FEATURE_DISABLED');
}

function aiAgentDisabled(agentCode) {
  return new AppError('Este agente está desativado.', 409, 'AI_AGENT_DISABLED', agentCode ? { agent: String(agentCode).toUpperCase() } : undefined);
}

function aiNotAvailable(feature) {
  return new AppError('Este recurso da NAY ainda não está disponível.', 501, 'AI_NOT_AVAILABLE', { feature });
}

module.exports = { aiFeatureDisabled, aiAgentDisabled, aiNotAvailable };
