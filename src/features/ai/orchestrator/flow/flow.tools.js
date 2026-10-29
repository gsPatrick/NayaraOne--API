'use strict';

const { sanitizeModelToolCall } = require('../../tools/modelToolCall');
const { runToolCall } = require('../toolCallPipeline');
const { createCallRecorder } = require('../callRecorder');
const { isToolBlock } = require('./flow.outcome');
const { absorbToolOutput } = require('./flow.toolResult');
const { checkDeadline } = require('./flow.deadline');

const SECURITY_CODES = ['AI_CROSS_COMPANY_BLOCKED', 'AI_SECRET_REQUEST_BLOCKED', 'AI_TOOL_LIMIT_EXCEEDED', 'AI_INJECTION_BLOCKED', 'AI_CONNECTION_NOT_ALLOWED'];
const topicOf = (toolName) => String(toolName).split('.')[0] || toolName;

/** Marca o tema que ficou sem resposta (a resposta final cita "sem permissão para <tema>"). */
function noteUnmet(state, toolName, err) {
  const kind = err.code === 'AI_PERMISSION_DENIED' ? 'PERMISSION' : 'UNAVAILABLE';
  if (!state.unmet.some((u) => u.topic === topicOf(toolName) && u.kind === kind)) state.unmet.push({ topic: topicOf(toolName), kind, code: err.code, status: err.statusCode, message: err.message });
  state.unavailable.add(toolName);
  state.blockedTools.push({ tool: toolName, error: err });
}

/** Registra no run a chamada acima do teto de tools (BLOCKED / TOOL_LIMIT) antes de o erro encerrar o run. */
async function recordLimitBlock(state, call, seq, err) {
  const recorder = createCallRecorder({
    execCtx: state.execCtx, registry: state.toolRegistry, agentCode: state.agent.code, requestText: state.parsed.input, transaction: state.transaction, args: call.arguments, seq,
  });
  const entry = { toolName: call.name, correlationId: state.execCtx.correlationId, companyId: state.ctx.companyId, groupId: state.ctx.groupId, inputKeys: Object.keys(call.arguments || {}), status: 'BLOCKED', blockedReason: 'TOOL_LIMIT', reason: 'tool_limit' };
  await recorder.record(entry);
  await recorder.emit({ type: 'ai.tool_call.blocked', payload: entry });
  throw err;
}

/** Uma tool pedida pelo modelo: teto de tools (guarda), allowlist/permissão/entidade/schema/segredo (D017/D018), execução ou proposta (D019). */
async function runOneTool(state, raw) {
  const call = sanitizeModelToolCall(raw);
  state.seq += 1;
  const seq = state.seq;
  if (state.unavailable.has(call.name)) return { tool: call.name, status: 'UNAVAILABLE', output: null };
  try {
    state.guard.beforeToolCall(call.name);
  } catch (err) {
    if (err.code === 'AI_TOOL_LIMIT_EXCEEDED') await recordLimitBlock(state, call, seq, err);
    // fora da allowlist: o pipeline abaixo registra a linha BLOCKED, o evento e devolve o mesmo erro
  }
  const recorder = createCallRecorder({
    execCtx: state.execCtx, registry: state.toolRegistry, agentCode: state.agent.code, requestText: state.parsed.input, transaction: state.transaction, args: call.arguments, seq,
  });
  try {
    const res = await state.trace.span(7, 'validar_tool', () => runToolCall({
      execCtx: state.execCtx, agent: state.agent, registry: state.toolRegistry, toolName: call.name, args: call.arguments, requestText: state.parsed.input, source: 'USER',
      transaction: state.transaction, recorder,
      executorOptions: { seq, untrustedTexts: state.untrustedTexts, actorTexts: state.actorTexts, injectionLimits: state.injectionLimits },
    }));
    if (res.status === 'PROPOSED') state.trace.mark(8, 'criar_proposta'); else state.trace.mark(9, 'executar_tool');
    return { tool: call.name, status: res.status, output: res.output, proposal: res.proposal, replayed: res.replayed === true };
  } catch (err) {
    if (isToolBlock(err)) { noteUnmet(state, call.name, err); return { tool: call.name, status: 'UNAVAILABLE', output: null, error: err }; }
    if (SECURITY_CODES.includes(err.code) || !err.isOperational || err.code === 'AI_TOOL_CALL_IN_PROGRESS') throw err;
    return { tool: call.name, status: 'FAILED', output: null, error: err };
  }
}

/**
 * Passos 7 a 9 para as tools pedidas numa volta, em ordem. Tool bloqueada por allowlist, permissão ou schema NÃO derruba o run (o
 * modelo recebe "ferramenta indisponível" e a resposta cita a parte não atendida); segurança (outra empresa, segredo, injeção) e o teto
 * de tools terminam o run. Proposta criada PARA o run (AWAITING_APPROVAL): nenhuma outra tool é executada. Resultado de leitura vira fonte.
 */
async function processToolRequests(state, toolRequests) {
  const results = [];
  for (const raw of toolRequests) {
    checkDeadline(state);
    const result = await runOneTool(state, raw);
    results.push(result);
    if (result.status === 'PROPOSED') {
      state.proposals.push(result.proposal);
      return { results, stoppedByProposal: true };
    }
    if (result.status === 'SUCCEEDED') await absorbToolOutput(state, result.tool, result.output);
  }
  return { results, stoppedByProposal: false };
}

module.exports = { processToolRequests, runOneTool, topicOf };
