'use strict';

const { aiAgentDisabled } = require('../ai.errors');
const E = require('./agents.errors');
const repo = require('./agents.repository');
const { ctxOk } = require('./agentAccess');
const { normalizeCode } = require('./agents.validation');

/**
 * Versão do agente que vai rodar: a ACTIVE da empresa; se a empresa não tem, a do sistema; se nenhuma está ACTIVE e
 * habilitada, 409 AI_AGENT_DISABLED. (A chave por agente `ai.agents.enabled` é do aiGate, D003.)
 */
async function resolveActiveAgent(rawCode, ctx, transaction) {
  ctxOk(ctx);
  const code = normalizeCode(rawCode);
  if (!code) throw aiAgentDisabled(rawCode);
  const agent = await repo.findActiveFor(ctx, code, transaction);
  if (!agent || !agent.enabled) throw aiAgentDisabled(code);
  return agent;
}

/** O que o run grava para saber com qual versão rodou (D005/D020 persistem em ai.runs). */
function runStamp(agent) {
  return { agentId: agent.id, agentCode: agent.code, agentVersion: agent.version };
}

/** A tool só pode ser chamada se está na allowlist do agente e habilitada; qualquer outra é 403 AI_TOOL_NOT_ALLOWED. */
function assertToolAllowed(agent, toolName) {
  const tool = (agent.tools || []).find((t) => t.enabled && t.toolName === toolName);
  if (!tool) throw E.toolNotAllowed(toolName);
  return tool;
}

module.exports = { resolveActiveAgent, runStamp, assertToolAllowed };
