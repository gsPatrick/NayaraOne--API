'use strict';

/**
 * Registro das chamadas de ferramenta da NAY (M9-D006): é o `recorder` que o executor de tools (M9-D002) recebe. Um recorder
 * por chamada, preso à empresa, ao run e à transação do tenant.
 *  - claim: grava REQUESTED com argumentos sanitizados e hash ANTES de qualquer execução. Mesma chave (empresa, tool,
 *    `run_id:seq:args_hash`) => replay: devolve o resultado anterior com replayed=true, sem executar (409 se ainda em andamento);
 *  - record: leva a mesma linha por REQUESTED -> VALIDATED -> EXECUTING -> SUCCEEDED | FAILED, ou -> PROPOSED, ou -> BLOCKED;
 *  - emit: evento ai.tool_call.blocked no outbox (mesma transação).
 * Trilha de auditoria antes/depois a cada mudança de estado relevante; nada de argumento ou resultado na auditoria.
 */
const crypto = require('node:crypto');
const { AiRun, AiToolCall } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const runsErrors = require('../orchestrator/runs/runs.errors');
const E = require('./toolCalls.errors');
const C = require('./toolCalls.constants');
const { hashOf, sanitizeArgs, summarizeResult } = require('./toolCallSanitizer');
const { toToolCall } = require('./toolCalls.mapper');
const { replayOutcome } = require('./toolCallReplay');
const { auditToolCall, publishToolCallEvent } = require('./toolCallEvents');
const { TOOL_RESULT_MAX_KEY, TOOLCALL_SETTING_DEFAULTS } = require('./toolCalls.settings');
const support = require('../readmodels/toolCallSupport.readmodel');
const { countBlocked } = require('./toolCallsBlockedCounter');
const { observe } = require('../observability/observe');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAIN = ['REQUESTED', 'VALIDATED', 'EXECUTING'];

/** Estados intermediários que faltam até o destino (a chamada anda pela máquina inteira, sem pular). */
function stepsTo(from, target) {
  const through = target === 'SUCCEEDED' || target === 'FAILED' ? ['VALIDATED', 'EXECUTING'] : target === 'PROPOSED' ? ['VALIDATED'] : [];
  return [...through.filter((s) => CHAIN.indexOf(s) > CHAIN.indexOf(from)), target];
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

async function resultLimit(ctx, transaction) {
  const n = Number(await getSetting(TOOL_RESULT_MAX_KEY, ctx, transaction, TOOLCALL_SETTING_DEFAULTS[TOOL_RESULT_MAX_KEY]));
  return Number.isInteger(n) && n >= 1 ? n : TOOLCALL_SETTING_DEFAULTS[TOOL_RESULT_MAX_KEY];
}

function createToolCallRecorder({ ctx, transaction, runId, clock = () => Date.now() } = {}) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
  if (!UUID_RE.test(String(runId))) throw E.invalid('A chamada de ferramenta precisa de um run válido.');
  let current = null;
  let claimedAt = 0;
  let before = null;
  let lastEntry = null;

  async function claim({ toolName, tool, args, seq, idempotencyKey } = {}) {
    return guarded(async () => {
      const run = await AiRun.findOne({ where: { id: runId, companyId: ctx.companyId }, transaction });
      if (!run) throw runsErrors.notFound();
      const argsHash = hashOf(args);
      let order = seq;
      if (order === undefined || order === null) {
        await support.lockRunSequence(runId, transaction);
        order = await support.nextSequence(runId, transaction);
      }
      if (!Number.isInteger(order) || order < 1) throw E.invalid('A ordem (seq) da chamada deve ser um inteiro maior que zero.');
      const key = idempotencyKey || `${runId}:${order}:${argsHash}`;
      const name = (tool && tool.name) || toolName;
      const id = crypto.randomUUID();
      const inserted = await support.insertIfAbsent({
        id, groupId: ctx.groupId, companyId: ctx.companyId, runId, seq: order, toolName: name, toolVersion: tool && tool.version !== undefined ? String(tool.version) : null,
        permissionCode: tool ? tool.permissionCode || tool.permission || 'UNDECLARED' : null, riskLevel: tool ? tool.riskLevel || 'LOW' : null,
        argsSanitized: sanitizeArgs(args, tool && tool.inputSchema), argsHash, idempotencyKey: key, userId: ctx.userId || null,
      }, transaction);
      if (!inserted) {
        const existing = await AiToolCall.findOne({ where: { companyId: ctx.companyId, toolName: name, idempotencyKey: key }, transaction });
        return { replayed: true, outcome: replayOutcome(toToolCall(existing)) };
      }
      current = await AiToolCall.findByPk(id, { transaction });
      claimedAt = clock();
      before = toToolCall(current);
      await auditToolCall(ctx, 'ai.tool_call.requested', before, null, 'Chamada de ferramenta da NAY registrada.', transaction);
      return { replayed: false, toolCallId: id };
    });
  }

  /** entry: { status: BLOCKED | PROPOSED | SUCCEEDED | FAILED, reason, blockedReason, capability, proposalId, output, correlationId }. */
  async function record(entry) {
    if (!current) throw E.notClaimed();
    lastEntry = entry;
    return guarded(async () => {
      const target = entry.status;
      if (!C.STATUSES.includes(target)) throw E.invalid('Estado de chamada desconhecido.');
      const limit = target === 'SUCCEEDED' ? await resultLimit(ctx, transaction) : 0;
      for (const step of stepsTo(current.status, target)) {
        const set = { status: step, updatedBy: ctx.userId || null };
        if (step === target) Object.assign(set, finalFields(entry, target, limit));
        await current.update(set, { transaction });
      }
      await current.reload({ transaction });
      await observe(ctx, transaction, (m) => m.toolCall(current.toolName, current.status)); // M9-D047: ai_tool_calls_total
      if (target === 'BLOCKED') countBlocked(current.blockedReason); // M9-D681: o contador sai da mesma linha que o KPI ai.tool_calls_blocked soma
      await auditToolCall(ctx, 'ai.tool_call.state_changed', toToolCall(current), before, `Chamada de ferramenta da NAY: ${before.status} para ${current.status}.`, transaction);
      return toToolCall(current);
    });
  }

  function finalFields(entry, target, limit) {
    const set = {};
    if (target === 'BLOCKED') {
      // motivo específico (SCHEMA, tool_nao_registrada...); o genérico "capacidade_nao_concedida" cede lugar à capacidade pedida
      const generic = !entry.reason || entry.reason === 'capacidade_nao_concedida';
      set.blockedReason = String(entry.blockedReason || (generic ? entry.capability || entry.reason : entry.reason) || 'bloqueada').slice(0, 80);
    }
    if (target === 'PROPOSED') set.proposalId = entry.proposalId || null;
    if (target === 'SUCCEEDED') {
      set.resultSummary = summarizeResult(entry.output, limit);
      set.resultHash = hashOf(entry.output);
    }
    if (target === 'FAILED') set.resultSummary = { error: String(entry.reason || 'erro_da_tool').slice(0, 120) };
    if (['SUCCEEDED', 'FAILED', 'BLOCKED', 'PROPOSED'].includes(target)) set.latencyMs = Math.max(0, clock() - claimedAt);
    return set;
  }

  async function emit(event) {
    if (!current || !event || event.type !== C.EVENT_BLOCKED) return null;
    const call = toToolCall(current);
    return publishToolCallEvent(ctx, event.type, call, { capability: lastEntry && lastEntry.capability, correlationId: lastEntry && lastEntry.correlationId }, transaction);
  }

  return { claim, record, emit, get current() { return current ? toToolCall(current) : null; } };
}

module.exports = { createToolCallRecorder };
