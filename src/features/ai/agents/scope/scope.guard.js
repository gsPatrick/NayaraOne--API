'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { getAgentScope } = require('./scope.registry');
const { evaluateScope, termsOf } = require('./scope.evaluate');

/**
 * Guarda do roteador (M9-D012, passo "regra"): para um agente com fronteira registrada, pedido fora do propósito ou que cai numa
 * proibição do livro é respondido SEM modelo (caminho RULE, 200). Pedido dentro do propósito devolve null e o roteador segue.
 * Os termos de cada lista são parâmetros da empresa (aba IA NAY); a mensagem de recusa de cada proibição é a do livro/demanda.
 */
async function scopeGuard(ruleInput, env) {
  const def = ruleInput && getAgentScope(ruleInput.agentCode);
  if (!def) return null;
  const tenant = env.tenant;
  const read = (key, fallback) => getSetting(key, tenant, env.transaction, fallback);
  const scopeTerms = termsOf(await read(def.scopeTermsKey, def.scopeTermsDefault), def.scopeTermsDefault);
  const prohibitions = [];
  for (const p of def.prohibitions) {
    // `enabled(env)`: a proibição só vale enquanto a configuração da empresa a mantém (ex.: M9-D036, "pagar" libera a PROPOSTA se o administrador ligar).
    if (typeof p.enabled === 'function' && !(await p.enabled(env, ruleInput))) continue;
    prohibitions.push({ code: p.code, terms: termsOf(await read(p.key, p.defaultTerms), p.defaultTerms) });
  }
  const verdict = evaluateScope(ruleInput.input, { scopeTerms, prohibitions });
  if (verdict.decision === 'IN_SCOPE') return null;
  if (verdict.decision === 'OUT_OF_SCOPE') return { answer: def.outOfScopeMessage, scope: 'OUT_OF_SCOPE' };
  const rule = def.prohibitions.find((p) => p.code === verdict.code);
  if (typeof rule.respond === 'function') {
    const custom = await rule.respond(ruleInput, env);
    if (custom) return { ...(typeof custom === 'string' ? { answer: custom } : custom), scope: 'FORBIDDEN', prohibition: rule.code };
  }
  return { answer: rule.message, scope: 'FORBIDDEN', prohibition: rule.code };
}

/** Marca obrigatória da resposta do agente (ex.: minuta). Agente sem regra devolve o texto como veio. */
async function applyAgentOutputRules(agentCode, info, answer) {
  const def = getAgentScope(agentCode);
  return def && typeof def.decorate === 'function' ? def.decorate(answer, info) : answer;
}

module.exports = { scopeGuard, applyAgentOutputRules };
