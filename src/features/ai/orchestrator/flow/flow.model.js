'use strict';

const budgets = require('../../budgets');
const { toMicro, fromMicro } = require('../../budgets/budgets.money');
const E = require('./flow.errors');
const { refineRoute } = require('./flow.route');
const { evaluateOutput } = require('./flow.output');
const { checkDeadline, remainingMs } = require('./flow.deadline');

const RETRYABLE = ['TIMEOUT', 'UNAVAILABLE', 'RATE_LIMIT'];
const MAX_ATTEMPTS = 5;

/** Falha do provedor -> o erro da tabela "Falha por passo": tempo estourado 504, indisponível 503; configuração e segurança do fornecedor seguem como estão. */
function mapProviderError(err) {
  if (!err || err.name !== 'AiProviderError') return err && err.isOperational ? err : E.providerUnavailable({ providerKind: 'UNKNOWN' });
  if (err.kind === 'TIMEOUT') return E.runTimeout();
  if (['UNAVAILABLE', 'RATE_LIMIT', 'UNKNOWN'].includes(err.kind)) return E.providerUnavailable({ providerKind: err.kind });
  return err;
}

function addUsage(state, usage, cost) {
  state.usage.tokensIn += usage.tokensIn || 0;
  state.usage.tokensOut += usage.tokensOut || 0;
  state.usage.costMicro += toMicro(cost || '0');
  state.guard.recordUsage({ tokensIn: usage.tokensIn || 0, tokensOut: usage.tokensOut || 0 });
}

/** Cadeia de fallback (D013): o seletor injetado devolve a próxima decisão equivalente ou lança 503 AI_FALLBACK_UNSAFE; sem seletor, falha com o erro do provedor. */
async function nextOnFailure(state, err, attempt, startedMs) {
  const selector = state.deps.fallbackSelector;
  if (!selector || !RETRYABLE.includes(err.kind) || attempt >= MAX_ATTEMPTS) throw mapProviderError(err);
  const from = state.decision;
  const usage = { structuredOutput: Boolean(state.agent.modelPolicy && state.agent.modelPolicy.outputSchema), toolUse: (state.agent.tools || []).some((t) => t.enabled) };
  const next = await selector({ decision: from, error: { kind: err.kind, providerCode: from.provider }, attempt, ctx: state.ctx, transaction: state.transaction, input: state.routerInput, usage })
    .catch((failure) => { throw failure && failure.code === 'AI_PROVIDER_UNAVAILABLE' ? mapProviderError(err) : failure; }); // sem substituto: o erro do provedor (tempo estourado segue 504)
  if (!next) throw E.providerUnavailable({ providerKind: err.kind });
  state.fallbackTrail.push({ from: `${from.provider}/${from.model}`, to: `${next.provider}/${next.model}`, reason: err.kind, ms: Math.max(0, state.clock() - startedMs) });
  state.decision = next;
  return next;
}

async function callOnce(state, request) {
  const { ctx, transaction, deps } = state;
  const decision = state.decision;
  const adapter = await deps.registry.instance(decision.provider, ctx, transaction);
  const input = {
    agentCode: state.agent.code, criticality: state.agent.criticality, routingPath: decision.path, estimate: decision.estimatedCost || '0', at: new Date(state.clock()),
  };
  const paid = await budgets.spendWithBudget(ctx, input, async () => {
    const response = await adapter.generate({ ...request, model: decision.model });
    return { cost: response.costAmount, response };
  }, transaction);
  state.alerts.push(...paid.alertsRaised);
  return paid.response;
}

/**
 * Passo 6: UMA geração do modelo. Antes: teto de tokens do run (AgentRunGuard), prazo total do run e reserva do orçamento
 * (reserve -> chamada -> settle com o custo real; release em qualquer falha, D014). O adapter vem do ProviderRegistry (D011).
 * Falha de indisponibilidade tenta o seletor de fallback seguro (D013) quando ele existe.
 */
async function generateOnce(state, { system, messages, tools, hint }) {
  state.guard.beforeModelCall();
  checkDeadline(state);
  const policy = state.agent.modelPolicy || {};
  const base = {
    system: hint ? `${system}\n\n${hint}` : system,
    messages,
    tools: tools || [],
    maxOutputTokens: Number.isInteger(policy.maxOutputTokens) ? policy.maxOutputTokens : state.routerInput.maxOutputTokens,
    temperature: 0,
    timeoutMs: Math.max(1, Math.min(state.guard.limits.timeoutMs, remainingMs(state))),
    correlationId: state.parsed.correlationId || state.runId,
  };
  if (policy.outputSchema) base.responseSchema = policy.outputSchema;
  for (let attempt = 1; ; attempt += 1) {
    state.modelCalls += 1;
    const startedMs = state.clock();
    try {
      const response = await callOnce(state, { ...base, idempotencyKey: `${state.runId}:${state.modelCalls}` });
      addUsage(state, response.usage || {}, response.costAmount);
      state.latestResponse = response;
      return response;
    } catch (err) {
      if (err && err.name !== 'AiProviderError') throw err;
      await nextOnFailure(state, err, attempt, startedMs);
    }
  }
}

/**
 * Uma volta de geração com o escalonamento do roteador (D012): se o modelo pequeno devolve saída fora do schema ou com `confidence`
 * abaixo do mínimo, escala UMA vez para o avançado (nova chamada paga, `escalated=true`). O custo das duas chamadas fica no run.
 */
async function generateWithEscalation(state, args) {
  let response = await generateOnce(state, args);
  const outcome = evaluateOutput(state.agent, response.text);
  if (!(response.toolRequests || []).length && state.decision.path === 'SMALL_MODEL') {
    const advanced = await state.deps.router.escalate(state.decision, outcome, state.routerInput, state.ctx, state.transaction);
    if (advanced) {
      state.decision = advanced;
      state.routingPath = advanced.path;
      state.escalated = true;
      response = await generateOnce(state, args);
    }
  }
  return response;
}

/** Primeira volta: reescolhe o modelo com o tamanho real do prompt montado (o passo 3 usou só a estimativa da pergunta). */
const prepareFirstTurn = (state) => refineRoute(state, state.promptTokens);

const totalCost = (state) => fromMicro(state.usage.costMicro);

module.exports = { generateOnce, generateWithEscalation, prepareFirstTurn, totalCost, mapProviderError };
