'use strict';

const { HIGH_IMPACT_AGENTS } = require('./evaluations.constants');
const { HIGH_RISK } = require('../agents/agents.constants');

/** Alto impacto (livro, AI-015): NAY_FINANCEIRA, NAY_JURIDICA, NAY_CORRESPONDENTE ou qualquer agente com tool HIGH/CRITICAL habilitada. */
function isHighImpact(agent) {
  if (!agent) return false;
  if (HIGH_IMPACT_AGENTS.includes(String(agent.code || '').toUpperCase())) return true;
  return (agent.tools || []).some((t) => t.enabled !== false && HIGH_RISK.includes(t.riskLevel));
}

module.exports = { isHighImpact };
