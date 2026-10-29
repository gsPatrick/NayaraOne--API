'use strict';

const E = require('./regression.errors');
const { computeGlobalHash } = require('./globalHash');
const { passedSuitesForHashes, passedSuitesForPair } = require('../readmodels/regressionSupport.readmodel');

/** Verde = PASSED na suíte ALL, ou PASSED em GOLDEN e em ADVERSARIAL (mesma regra da avaliação da versão). */
const isGreen = (suites) => suites.has('ALL') || (suites.has('GOLDEN') && suites.has('ADVERSARIAL'));

/** Par provider/modelo de uma política de modelo (campos `provider` e `model`); null quando não informado. */
function pairOf(modelPolicy) {
  const policy = modelPolicy && typeof modelPolicy === 'object' ? modelPolicy : {};
  const provider = typeof policy.provider === 'string' && policy.provider.trim() ? policy.provider.trim() : null;
  const model = typeof policy.model === 'string' && policy.model.trim() ? policy.model.trim() : null;
  return { provider, model };
}

const samePair = (a, b) => a.provider === b.provider && a.model === b.model;

/**
 * Homologar e ativar exigem avaliação GOLDEN + ADVERSARIAL PASSED para o `config_hash` da versão E para o `global_hash` de agora
 * (`homologated: true` na ativação: a avaliação já homologada por uma pessoa). Só vale para versão que já tem alguma avaliação
 * verde; sem nenhuma, a recusa é a da D004/D032 (AI_AGENT_EVALUATION_REQUIRED / AI_AGENT_NOT_HOMOLOGATED).
 */
async function assertRegressionPassed(ctx, agent, { homologated = false } = {}, transaction) {
  const globalHash = await computeGlobalHash(ctx, transaction);
  const suites = await passedSuitesForHashes(ctx.companyId, agent.code, agent.version, { configHash: agent.configHash, globalHash, homologated }, transaction);
  if (!isGreen(suites)) throw E.regressionRequired({ agentCode: agent.code, agentVersion: agent.version, motivo: 'hash sem avaliação aprovada' });
  return { configHash: agent.configHash, globalHash };
}

/** Trocar provider ou modelo do agente exige avaliação aprovada do agente para o novo par. Par igual ao anterior ou vazio passa. */
async function assertAgentPairEvaluated(ctx, code, previousPolicy, nextPolicy, transaction) {
  const next = pairOf(nextPolicy);
  if (!next.provider && !next.model) return { checked: false };
  if (samePair(pairOf(previousPolicy), next)) return { checked: false };
  const suites = await passedSuitesForPair(ctx.companyId, { agentCode: code, provider: next.provider, model: next.model }, transaction);
  if (!next.provider || !isGreen(suites)) throw E.regressionRequired({ agentCode: code, provider: next.provider, model: next.model });
  return { checked: true };
}

/** Trocar o provedor ou o modelo padrão da empresa exige avaliação aprovada (de qualquer agente) para o novo par. */
async function assertCompanyPairEvaluated(ctx, pair, transaction) {
  const suites = await passedSuitesForPair(ctx.companyId, { provider: pair.provider, model: pair.model }, transaction);
  if (!isGreen(suites)) throw E.regressionRequired({ provider: pair.provider, model: pair.model });
  return { checked: true };
}

module.exports = { assertRegressionPassed, assertAgentPairEvaluated, assertCompanyPairEvaluated, pairOf, isGreen };
