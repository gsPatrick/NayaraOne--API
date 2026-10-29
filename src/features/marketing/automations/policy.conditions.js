'use strict';

const { evaluateRule } = require('../../../engines/rules/rulesEngine');

/**
 * Conditions da versão: cada uma é o `ruleCode` de uma regra do Motor de Regras, avaliada contra os facts da pessoa. O resultado é
 * verdadeiro somente se TODAS retornam verdadeiro (decisão APPLY). Regra que não casa = CONDITION_FALSE. Regra inexistente,
 * conflitante, erro de avaliação ou exceção do motor = CONDITION_ERROR (fail-closed: nada é enviado). Devolve { allowed, reason?,
 * trace } com o resultado de cada regra (para o policy_trace da run).
 */
async function evaluateConditions(conditions, facts, tenant, transaction, now) {
  const trace = [];
  for (const ruleCode of Array.isArray(conditions) ? conditions : []) {
    let outcome;
    try {
      outcome = await evaluateRule(ruleCode, facts, tenant, { transaction, now });
    } catch (err) {
      outcome = { decision: 'DENY', reason: 'RULE_ENGINE_ERROR' };
    }
    const matched = outcome && outcome.decision === 'APPLY';
    trace.push({ ruleCode, decision: outcome ? outcome.decision : 'DENY', reason: outcome ? outcome.reason : 'RULE_ENGINE_ERROR' });
    if (matched) continue;
    const isFalse = outcome && outcome.decision === 'DENY' && outcome.reason === 'RULE_CONDITION_NOT_MET';
    return { allowed: false, reason: isFalse ? 'CONDITION_FALSE' : 'CONDITION_ERROR', ruleCode, trace };
  }
  return { allowed: true, trace };
}

module.exports = { evaluateConditions };
