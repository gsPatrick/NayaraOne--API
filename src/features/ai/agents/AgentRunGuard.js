'use strict';

const E = require('./agents.errors');
const { resolveLimits } = require('./agentLimits');
const { runStamp, assertToolAllowed } = require('./agentResolver.service');

/**
 * Guarda de UM run: allowlist e teto de tool calls, teto de tokens acumulados e taxa por usuário. O orquestrador (D020) cria um
 * por run, chama `assertRateCount` ao abrir, `beforeToolCall` antes de cada tool, `beforeModelCall` antes de cada chamada ao
 * modelo e `recordUsage` depois dela. Estouro de tool: 422 AI_TOOL_LIMIT_EXCEEDED (run BLOCKED, TOOL_LIMIT); de tokens: 422
 * AI_TOKEN_LIMIT_EXCEEDED (run FAILED); de taxa: 429 AI_RATE_LIMITED. O motivo do run segue em `error.details`.
 */
class AgentRunGuard {
  constructor(agent, ctx, limits) {
    this.agent = agent;
    this.ctx = ctx;
    this.limits = limits;
    this.toolCalls = 0;
    this.tokens = 0;
  }

  static async create(agent, ctx, transaction) {
    return new AgentRunGuard(agent, ctx, await resolveLimits(agent, ctx, transaction));
  }

  stamp() {
    return runStamp(this.agent);
  }

  /** Taxa por pessoa em contador de banco (DI-D004-7): `recent` é quantos runs da pessoa começaram no último minuto (ai.ai_runs). */
  assertRateCount(recent) {
    if (Number.isInteger(recent) && recent >= this.limits.maxRunsPorMinutoUsuario) throw E.rateLimited();
  }

  beforeToolCall(toolName) {
    const tool = assertToolAllowed(this.agent, toolName);
    if (this.toolCalls + 1 > this.limits.maxToolCallsPorRun) throw E.toolLimit();
    this.toolCalls += 1;
    return tool;
  }

  /** Só barra quando o acumulado JÁ passou do teto (estar exatamente no teto ainda deixa a última chamada acontecer). */
  beforeModelCall() {
    if (this.tokens > this.limits.maxTokensRun) throw E.tokenLimit();
  }

  recordUsage({ tokensIn = 0, tokensOut = 0 } = {}) {
    if (![tokensIn, tokensOut].every((n) => Number.isInteger(n) && n >= 0)) throw E.invalid('Uso de tokens inválido.');
    this.tokens += tokensIn + tokensOut;
  }
}

module.exports = { AgentRunGuard };
