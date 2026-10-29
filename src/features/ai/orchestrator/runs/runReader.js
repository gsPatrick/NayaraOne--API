'use strict';

const { AiRun, AiSource, AiToolCall } = require('../../../../models');
const E = require('./runs.errors');
const V = require('./runs.validation');
const { toRun, toSource } = require('./runs.mapper');

/** Resumo de uma tool call: nome, estado e motivo do bloqueio, nunca argumentos nem resultado (isso é de ai:audit na trilha de tool calls). */
function toToolCallSummary(row) {
  return {
    seq: row.seq, toolName: row.toolName, status: row.status, riskLevel: row.riskLevel, blockedReason: row.blockedReason,
    latencyMs: row.latencyMs, proposalId: row.proposalId,
  };
}

/** Eventos de bloqueio do run: a tool bloqueada (allowlist, permissão, schema, empresa...) e o bloqueio que terminou o próprio run. */
function blockEventsOf(run, toolCalls) {
  const events = toolCalls.filter((t) => t.status === 'BLOCKED').map((t) => ({ scope: 'TOOL', seq: t.seq, toolName: t.toolName, blockedReason: t.blockedReason }));
  if (run.status === 'BLOCKED') events.push({ scope: 'RUN', blockedReason: run.blockedReason, errorCode: run.errorCode });
  return events;
}

/**
 * Lê um run com as fontes. `ai:audit` lê qualquer run da empresa; `ai:read` só os próprios; quem não tem nenhuma das duas
 * recebe 403. Run de outra empresa, de outra pessoa (sem ai:audit) ou inexistente: 404 igual, sem revelar existência.
 */
async function getRun(ctx, id, transaction) {
  V.ctxOk(ctx);
  const permissions = ctx.permissions || [];
  const audit = permissions.includes('ai:audit');
  if (!audit && !permissions.includes('ai:read')) throw E.denied();
  if (!V.isUuid(id)) throw E.notFound();
  const row = await AiRun.findOne({ where: { id, companyId: ctx.companyId }, transaction });
  if (!row || (!audit && row.userId !== ctx.userId)) throw E.notFound();
  const sources = await AiSource.findAll({ where: { aiRunId: row.id, companyId: ctx.companyId }, order: [['retrievedAt', 'ASC'], ['id', 'ASC']], transaction });
  const calls = await AiToolCall.findAll({ where: { runId: row.id, companyId: ctx.companyId }, order: [['seq', 'ASC']], transaction });
  const run = toRun(row);
  const toolCalls = calls.map(toToolCallSummary);
  return {
    ...run, sources: sources.map(toSource), toolCalls, blockEvents: blockEventsOf(run, toolCalls), cost: { amount: run.costAmount, currency: run.costCurrency },
  };
}

module.exports = { getRun };
