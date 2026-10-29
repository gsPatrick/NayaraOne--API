'use strict';

/**
 * M9-D691 (3.1 passos 1 a 4) — avalia UMA definição de alerta PUBLISHED para a empresa: carrega o valor confiável (engine.snapshot), avalia a
 * condição (limite decimal ou regra publicada), monta o fingerprint e entrega à máquina de estados. Métrica sem valor confiável deixa a definição
 * "em espera" (ON_HOLD) sem tocar em nenhuma instância. Cada chamada roda na transação própria do chamador.
 */
const { loadAlertInput } = require('./engine.snapshot');
const { compareThreshold } = require('./decimal');
const { fingerprintOf } = require('./fingerprint');
const { publishedRule, ruleHolds } = require('./engine.rule');
const { applyEvaluation, closeChangedInstances } = require('./engine.state');

async function conditionOf(def, input, scope, now, transaction) {
  if (def.condition_type === 'THRESHOLD') {
    const { operator, value } = def.threshold;
    return { holds: compareThreshold(input.value, operator, value), canonical: { type: 'THRESHOLD', operator, value } };
  }
  const rule = await publishedRule(def.rule_id, transaction); // regra rascunho ou aposentada nunca roda
  return { holds: await ruleHolds(rule, input, def, scope, { now }, transaction), canonical: { type: 'RULE_ENGINE', ruleId: def.rule_id, ruleVersion: rule.version } };
}

/** Devolve { alertCode, action, ... }: OPENED, REPEATED, SUPPRESSED, RESOLVED, NORMALIZING, NORMAL, UNCHANGED ou ON_HOLD. */
async function evaluateDefinition(def, scope, params, now, transaction) {
  const input = await loadAlertInput(def, scope, { now }, transaction);
  if (input.hold) return { alertCode: def.alert_code, action: 'ON_HOLD', reason: input.hold };
  const { holds, canonical } = await conditionOf(def, input, scope, now, transaction);
  const fingerprint = fingerprintOf({ metricCode: def.metric_code, companyId: scope.companyId, scope: def.scope || {}, condition: canonical });
  await closeChangedInstances(def, scope, fingerprint, now, transaction);
  const out = await applyEvaluation(
    { def, scope, params, fingerprint, metricCode: def.metric_code },
    { conditionTrue: holds, value: input.value, snapshotId: input.snapshot.id, now },
    transaction
  );
  return { alertCode: def.alert_code, action: out.action, instanceId: out.instance ? out.instance.id : null };
}

module.exports = { evaluateDefinition };
