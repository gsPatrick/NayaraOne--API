'use strict';

const { AgentRunGuard } = require('../../agents');
const runs = require('../runs');
const { buildUserContext } = require('../executionContext');
const { createPiiRedactor } = require('../../security/piiRedactor');
const { assertNotInsideRun, runGuarded } = require('./flow.reentrancy');
const { parseRunInput, requestHashOf } = require('./flow.input');
const { resolveAgent, openRun } = require('./flow.open');
const { createTrace } = require('./flow.trace');
const { resolveDeps } = require('./flow.deps');
const { readFlowParams } = require('./flow.params');
const { finalStateOf, failureOutcome } = require('./flow.outcome');
const { replayOutcome } = require('./flow.replay');
const { resolveRoute } = require('./flow.route');
const { fetchSources } = require('./flow.sources');
const { assemblePrompt } = require('./flow.prompt');
const { generateWithEscalation, generateOnce, prepareFirstTurn, totalCost } = require('./flow.model');
const { processToolRequests } = require('./flow.tools');
const { presetAnswer } = require('./flow.preset');
const { recordProgress } = require('./flow.progress');
const { validateAndFinish } = require('./flow.finalize');
const { finalizeFailure } = require('./flow.fail');
const { cacheAnswer } = require('./flow.cache');
const E = require('./flow.errors');

const AWAITING_TEXT = 'A NAY preparou uma ação, mas ela só será feita depois que uma pessoa autorizada aprovar. Há uma proposta pendente de aprovação.';
const UNAVAILABLE_NOTE = 'Ferramenta indisponível:';

function newState({ ctx, auth, parsed, agent, guard, run, deps, transaction, trace, params, requestHash }) {
  const startedAtMs = deps.clock();
  const execCtx = buildUserContext({ ...auth, userId: ctx.userId, groupId: ctx.groupId, companyId: ctx.companyId }, { correlationId: parsed.correlationId || run.correlationId, runId: run.id });
  return {
    ctx, execCtx, transaction, deps, agent, guard, parsed, params, requestHash, runId: run.id, clock: deps.clock, startedAtMs, deadline: startedAtMs + params.totalTimeoutMs,
    toolRegistry: deps.toolRegistry, trace, redactor: createPiiRedactor(), sources: [], numbersPayload: [], notices: [], proposals: [], unmet: [], unavailable: new Set(),
    blockedTools: [], toolNotes: [], publishedDetections: new Set(), usage: { tokensIn: 0, tokensOut: 0, costMicro: 0n }, modelCalls: 0, seq: 0, escalated: false,
    fallbackTrail: [], alerts: [], execution: null, decision: null, routerInput: null, latestResponse: null, routingPath: null, prompt: null, untrustedTexts: [], actorTexts: [], injectionLimits: null,
  };
}

const toolViews = (state) => state.toolRegistry.promptViewFor((state.agent.tools || []).filter((t) => t.enabled).map((t) => t.toolName));
const hintOf = (state, extra) => [state.toolNotes.length ? state.toolNotes.join(' ') : null, extra].filter(Boolean).join('\n');

/** Passos 6 a 9: gerar -> validar e executar as tools pedidas -> devolver o resultado ao modelo, até haver resposta (ou o teto de voltas). */
async function converse(state) {
  const { trace } = state;
  let turns = 0;
  let first = true;
  for (;;) {
    const response = await trace.span(6, 'gerar', async () => {
      if (first) { await prepareFirstTurn(state); first = false; }
      return generateWithEscalation(state, { system: state.prompt.system, messages: state.prompt.messages, tools: toolViews(state), hint: hintOf(state) });
    });
    const requests = response.toolRequests || [];
    if (!requests.length) return response.text;
    if (turns >= state.params.maxTurns) throw E.maxTurns();
    turns += 1;
    const { results, stoppedByProposal } = await processToolRequests(state, requests);
    if (stoppedByProposal) return null;
    for (const r of results) if (r.status !== 'SUCCEEDED' && r.status !== 'PROPOSED') state.toolNotes.push(`${UNAVAILABLE_NOTE} ${r.tool}.`);
    await assemblePrompt(state);
  }
}

/** Passos 10 a 12 numa resposta com texto: registrar, validar a saída e devolver. `regenerate` é a nova tentativa (volta ao passo 6). */
async function finish(state, text) {
  const { trace } = state;
  await trace.span(10, 'registrar', () => recordProgress(state));
  const regenerate = async (hint) => trace.span(6, 'gerar_nova_tentativa', async () => {
    if (state.decision.path === 'RULE' || state.decision.path === 'CACHE') throw E.outputInvalid();
    const response = await generateOnce(state, { system: state.prompt.system, messages: state.prompt.messages, tools: toolViews(state), hint: hintOf(state, hint) });
    await trace.span(10, 'registrar', () => recordProgress(state));
    return response.text;
  });
  const { run, answer, grounded } = await trace.span(11, 'validar_saida', () => validateAndFinish(state, text, regenerate));
  await cacheAnswer(state, { run, answer, grounded });
  const proposals = grounded.recommendation ? [{ id: grounded.recommendation.id, kind: 'CONFIRMATION' }] : [];
  return trace.span(12, 'devolver', async () => successOutcome(state, run, answer, grounded, proposals));
}

function successOutcome(state, run, answer, grounded, proposals) {
  return {
    ok: true, replayed: false, runId: run.id, status: run.status, answer, sources: grounded.sources || [], groundingStatus: run.groundingStatus, confidence: run.confidence,
    snapshotAt: run.snapshotAt, proposals: [...state.proposals, ...proposals], cost: { amount: run.costAmount, tokensIn: run.tokensIn, tokensOut: run.tokensOut },
    routingPath: run.routingPath, provider: run.providerCode, model: run.modelCode, escalated: run.escalated, cached: run.cached, budgetAlerts: state.alerts, trace: state.trace.spans,
  };
}

/** Run parado numa proposta (D019): o run já está AWAITING_APPROVAL; só registra o custo e devolve o aviso. Quem o fecha é o ApprovalService. */
async function finishAwaiting(state) {
  const { trace } = state;
  await trace.span(10, 'registrar', async () => {
    await recordProgress(state);
    return runs.recordRunProgress(state.ctx, state.runId, { outputSummary: AWAITING_TEXT }, state.transaction);
  });
  return trace.span(12, 'devolver', async () => ({
    ok: true, replayed: false, runId: state.runId, status: 'AWAITING_APPROVAL', answer: AWAITING_TEXT, sources: [], groundingStatus: null, confidence: null, snapshotAt: null,
    proposals: state.proposals, cost: { amount: totalCost(state), tokensIn: state.usage.tokensIn, tokensOut: state.usage.tokensOut }, routingPath: state.decision.path,
    provider: state.decision.provider, model: state.decision.model, escalated: state.escalated, cached: false, budgetAlerts: state.alerts, trace: state.trace.spans,
  }));
}

async function pipeline(state) {
  const { trace } = state;
  const decision = await trace.span(3, 'resolver_modelo_orcamento', () => resolveRoute(state));
  if (decision.path === 'RULE' || decision.path === 'CACHE') {
    const text = await trace.span(4, 'buscar_fontes', async () => presetAnswer(state, decision));
    return finish(state, text);
  }
  await trace.span(4, 'buscar_fontes', () => fetchSources(state));
  await trace.span(5, 'montar_prompt', () => assemblePrompt(state));
  const text = await converse(state);
  if (text === null) return finishAwaiting(state);
  // Nada útil restou (ferramenta bloqueada e nenhuma fonte para responder): o run termina BLOCKED com o HTTP e o código do bloqueio.
  if (state.blockedTools.length && !state.sources.some((s) => s.usedInAnswer)) throw state.blockedTools[0].error;
  return finish(state, text);
}

/**
 * AiOrchestrator.run — o fluxo de um run da NAY, passo a passo (Guia §5): 1 receber, 2 resolver o agente, 3 modelo e orçamento, 4 fontes,
 * 5 prompt, 6 gerar, 7 validar a tool, 8 proposta (para), 9 executar a tool, 10 registrar, 11 validar a saída, 12 devolver.
 * Falha depois do passo 1 NÃO lança: finaliza o run (FAILED ou BLOCKED) e devolve `{ ok: false, error: { status, code, message } }` com o
 * run gravado na mesma transação (o chamador a confirma e responde o HTTP do erro). Sem `purpose` (400), taxa por pessoa (429),
 * chave de idempotência com outro pedido (409) e chamada de dentro de uma tool (409) lançam antes de existir run.
 */
async function executeRun(rawInput, auth, transaction, rawDeps) {
  assertNotInsideRun();
  return runGuarded(async () => {
    const deps = resolveDeps(rawDeps);
    const trace = createTrace({ correlationId: rawInput && rawInput.correlationId, onSpan: deps.onSpan, clock: deps.clock });
    const ctx = { groupId: auth.groupId, companyId: auth.companyId, userId: auth.userId, permissions: auth.permissions || [] };
    const parsed = await trace.span(1, 'receber', async () => parseRunInput(rawInput));
    const opened = await trace.span(2, 'resolver_agente', async () => {
      const resolved = await resolveAgent(parsed, ctx, transaction);
      const guard = resolved.agent ? await AgentRunGuard.create(resolved.agent, ctx, transaction) : null;
      const open = (t) => openRun(parsed, resolved.agent, guard, ctx, t);
      return { ...resolved, guard, ...(await (deps.openTransaction ? deps.openTransaction(open) : open(transaction))) };
    });
    trace.setRunId(opened.run.id);
    if (opened.replay) return replayOutcome(ctx, opened.run, transaction, trace.spans);
    if (opened.error) return closeWithoutAgent(ctx, opened, transaction, trace);
    const params = await readFlowParams(ctx, transaction);
    const state = newState({ ctx, auth, parsed, agent: opened.agent, guard: opened.guard, run: opened.run, deps, transaction, trace, params, requestHash: requestHashOf(parsed) });
    try {
      return await pipeline(state);
    } catch (err) {
      return finalizeFailure(state, err);
    }
  });
}

/** Agente inexistente ou sem versão ativa: o run (aberto sem carimbo) termina FAILED com 404/409. */
async function closeWithoutAgent(ctx, opened, transaction, trace) {
  const final = finalStateOf(opened.error);
  await runs.finishRun(ctx, opened.run.id, { status: final.status, errorCode: final.errorCode }, transaction);
  return failureOutcome(opened.run.id, opened.error, final, { trace: trace.spans });
}

module.exports = { executeRun, newState };
