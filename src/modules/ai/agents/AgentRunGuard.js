'use strict';

const E = require('./agents.errors');
const { resolveLimits } = require('./agentLimits');
const { runStamp, assertToolAllowed } = require('./agentResolver.service');
const { defaultRunRateLimiter } = require('./RunRateLimiter');

/**
 * Guarda de UM run: allowlist e teto de tool calls, teto de tokens acumulados e taxa por usuário. O orquestrador (D020) cria um
 * por run, chama `assertRate` ao abrir, `beforeToolCall` antes de cada tool, `beforeModelCall` antes de cada chamada ao
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

  assertRate(limiter = defaultRunRateLimiter, now = Date.now()) {
    limiter.assertAllowed({ key: `${this.ctx.companyId}:${this.ctx.userId}`, limit: this.limits.maxRunsPorMinutoUsuario, now });
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
