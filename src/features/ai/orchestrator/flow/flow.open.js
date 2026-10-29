'use strict';

const agents = require('../../agents');
const agentsRepo = require('../../agents/agents.repository');
const { normalizeCode } = require('../../agents/agents.validation');
const { countRecentRuns } = require('../../readmodels/runSupport.readmodel');
const { WINDOW_MS } = require('../../agents/RunRateLimiter');
const runs = require('../runs');
const E = require('./flow.errors');
const { requestHashOf } = require('./flow.input');

/**
 * Passo 1 (receber: `parseRunInput` valida a finalidade) e passo 2 (resolver a versão do agente). A versão ACTIVE e habilitada é resolvida ANTES de abrir o run para que
 * ele nasça já carimbado com `agent_id` e `agent_version` (runStamp, M9-D004). Agente que não resolve: o run nasce sem carimbo e já
 * é finalizado FAILED (404 AI_AGENT_NOT_FOUND se o código nunca existiu; 409 AI_AGENT_DISABLED se não há versão ativa e habilitada).
 * Sem `purpose`: 400 AI_PURPOSE_REQUIRED e nenhum run é criado. Taxa por pessoa: contador de banco (429 AI_RATE_LIMITED, sem run).
 */
async function resolveAgent(parsed, ctx, transaction) {
  const code = normalizeCode(parsed.agentCode);
  if (!code) return { error: E.agentNotFound() };
  try {
    return { agent: await agents.resolveActiveAgent(code, ctx, transaction) };
  } catch (err) {
    if (err.code !== 'AI_AGENT_DISABLED') throw err;
    const versions = await agentsRepo.listByCode(ctx, code, transaction);
    return { error: versions.length ? err : E.agentNotFound() };
  }
}

async function openRun(parsed, agent, guard, ctx, transaction) {
  if (agent) guard.assertRateCount(await countRecentRuns(ctx.companyId, ctx.userId, WINDOW_MS / 1000, transaction, agent.code));
  return runs.startRun(ctx, {
    stamp: agent ? agents.runStamp(agent) : { agentCode: parsed.agentCode.toUpperCase().slice(0, 60) || 'DESCONHECIDO' },
    purpose: parsed.purpose,
    inputSummary: parsed.input,
    idempotencyKey: parsed.idempotencyKey,
    requestHash: requestHashOf(parsed),
    correlationId: parsed.correlationId,
    conversationId: parsed.conversationId,
    snapshotAt: parsed.snapshotAt,
  }, transaction);
}

module.exports = { resolveAgent, openRun };
