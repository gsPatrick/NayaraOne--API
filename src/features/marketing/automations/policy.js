'use strict';

const { buildAutomationFacts } = require('./facts');
const { evaluateConditions } = require('./policy.conditions');
const { evaluateCooldown } = require('./policy.cooldown');
const { blocked } = require('./policy.reasons');

/**
 * Passo 4 do runner (M9-D414): conditions pelo Motor de Regras e cooldown da automação para a pessoa e o canal. O frequency cap
 * NÃO é avaliado aqui: é avaliado uma única vez por tentativa de envio, dentro do canSend (M9-D418, posição 3).
 * `version` = { flowId, conditions, cooldown }; `subject` = { type: 'PERSON', id }. Devolve { allowed, trace } ou a decisão de
 * bloqueio (CONDITION_FALSE, CONDITION_ERROR, COOLDOWN com nextEligibleAt).
 */
async function evaluateAutomationPolicy({ version, subject, channel, now = new Date() }, tenant, transaction) {
  const facts = await buildAutomationFacts(subject, tenant, transaction, now);
  const conditions = await evaluateConditions(version.conditions, facts, tenant, transaction, now);
  if (!conditions.allowed) return blocked(conditions.reason, { trace: conditions.trace, ruleCode: conditions.ruleCode });
  const cooldown = await evaluateCooldown({ flowId: version.flowId, personId: subject.id, channel, cooldown: version.cooldown, now }, tenant, transaction);
  if (!cooldown.allowed) return blocked('COOLDOWN', { trace: conditions.trace, nextEligibleAt: cooldown.nextEligibleAt });
  return { allowed: true, trace: conditions.trace };
}

module.exports = { evaluateAutomationPolicy };
