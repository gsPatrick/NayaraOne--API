'use strict';

const { providerRegistry } = require('../ProviderRegistry');
const { readProviderParams } = require('../providers.params');
const { equivalenceProblems } = require('./equivalence');
const { readFallbackParams } = require('./fallback.params');
const { circuitIsOpen } = require('./circuit');
const E = require('./fallback.errors');

/** Falhas que justificam trocar de modelo. AUTH/VALIDATION (configuração) e SAFETY_BLOCKED (bloqueio do fornecedor) nunca. */
const TRIGGERS = Object.freeze(['TIMEOUT', 'UNAVAILABLE', 'RATE_LIMIT']);

const tenantOf = (ctx) => ({ groupId: ctx.groupId, companyId: ctx.companyId });
const sameModel = (entry, link) => entry.providerCode === link.provider && entry.model.model === link.model;

/** Condição 5: avaliação aprovada (GOLDEN + ADVERSARIAL ou ALL) do agente para o par provedor/modelo candidato (D033). */
async function evaluationIsGreen(ctx, { agentCode, provider, model }, transaction) {
  const { passedSuitesForPair } = require('../../readmodels/regressionSupport.readmodel');
  const { isGreen } = require('../../regression/regression.gate');
  return isGreen(await passedSuitesForPair(ctx.companyId, { agentCode, provider, model }, transaction));
}

function requestOf(input, usage) {
  const politica = (input && input.politica) || {};
  return {
    requiredCapabilities: (input && input.requiredCapabilities) || ['generate'],
    classification: politica.classification || 'INTERNAL',
    regions: politica.regions,
    structuredOutput: Boolean(usage && usage.structuredOutput),
    toolUse: Boolean(usage && usage.toolUse),
  };
}

/**
 * Seletor de fallback seguro (M9-D013), a porta `deps.fallbackSelector` do orquestrador. Recebe `{ decision, error, attempt, ctx, transaction,
 * input?, usage? }` e devolve a próxima decisão do ModelRouter (a cadeia `fallbackChain` sem o escolhido e sem os pulados), `null` quando a falha
 * não é de indisponibilidade, ou lança 503: `AI_PROVIDER_UNAVAILABLE` se nenhum candidato está elegível (cadeia vazia, desabilitado, circuito
 * aberto, ou acima de `ia.fallback.max_saltos`) e `AI_FALLBACK_UNSAFE` se há elegível mas todos reprovam a equivalência segura.
 * Nunca escolhe provedor só de laboratório em produção.
 */
function createFallbackSelector({ registry = providerRegistry, circuitOpen = circuitIsOpen, isGreen = evaluationIsGreen } = {}) {
  return async function selectFallback({ decision, error, attempt = 1, ctx, transaction, input, usage }) {
    if (!error || !TRIGGERS.includes(error.kind)) return null;
    const params = await readFallbackParams(ctx, transaction);
    const chain = (decision && decision.fallbackChain) || [];
    if (attempt > params.maxHops || !chain.length) throw E.providerUnavailable({ providerKind: error.kind });
    const source = typeof registry.entries === 'function' ? registry : providerRegistry;
    const entries = await source.entries(tenantOf(ctx), transaction);
    const original = entries.find((e) => sameModel(e, { provider: decision.provider, model: decision.model }));
    const production = (await readProviderParams(tenantOf(ctx), transaction)).production;
    const request = requestOf(input, usage);
    let eligible = 0;
    for (const [index, link] of chain.entries()) {
      const candidate = entries.find((e) => sameModel(e, link));
      if (!candidate || (await circuitOpen(candidate.providerCode, tenantOf(ctx), transaction))) continue;
      eligible += 1;
      const problems = original ? equivalenceProblems(original, candidate, request) : ['ORIGINAL_UNKNOWN'];
      if (candidate.policy.labOnly && production) problems.push('LAB_ONLY_IN_PRODUCTION');
      if (!problems.length && params.requireGreen && !(await isGreen(ctx, { agentCode: input && input.agentCode, provider: candidate.providerCode, model: candidate.model.model }, transaction))) problems.push('EVALUATION');
      if (problems.length) continue;
      return { ...decision, provider: link.provider, model: link.model, classe: link.classe, estimatedCost: link.estimatedCost, reason: 'FALLBACK_SAFE', fallbackChain: chain.slice(index + 1) };
    }
    throw eligible ? E.fallbackUnsafe({ providerKind: error.kind }) : E.providerUnavailable({ providerKind: error.kind });
  };
}

module.exports = { createFallbackSelector, TRIGGERS, evaluationIsGreen };
