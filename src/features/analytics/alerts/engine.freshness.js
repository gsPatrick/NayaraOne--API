'use strict';

/**
 * M9-D691 + M9-D609 — o alerta técnico de freshness: métrica CRITICAL com o dado mais recente STALE ou EXPIRED abre uma instância (uma por métrica,
 * fingerprint de `métrica | empresa | FRESHNESS_STALE`). A definição semente `analytics_freshness_critica` dá severidade e owner. Quando o dado volta
 * ao limite, a instância resolve pela mesma política de avaliações normais. Métrica sem snapshot não é avaliada.
 */
const { collectCriticalFreshness, publishStaleness } = require('../metrics/freshness.signal');
const { fingerprintOf } = require('./fingerprint');
const { applyEvaluation } = require('./engine.state');
const instances = require('./engine.instances');

const CONDITION = Object.freeze({ type: 'FRESHNESS_STALE' });
const SCOPE = Object.freeze({ kind: 'FRESHNESS' });

async function evaluateFreshnessDefinition(def, scope, params, now, transaction) {
  const items = await collectCriticalFreshness(scope, transaction, { now });
  const results = [];
  const seen = new Set();
  for (const item of items) {
    seen.add(item.metricCode);
    const fingerprint = fingerprintOf({ metricCode: item.metricCode, companyId: scope.companyId, scope: SCOPE, condition: CONDITION });
    const out = await applyEvaluation(
      { def, scope, params, fingerprint, metricCode: item.metricCode },
      { conditionTrue: item.state === 'STALE' || item.state === 'EXPIRED', value: null, snapshotId: item.snapshotId, now },
      transaction
    );
    if (out.action === 'OPENED') publishStaleness(item);
    results.push({ alertCode: def.alert_code, metricCode: item.metricCode, action: out.action, instanceId: out.instance ? out.instance.id : null });
  }
  // instância aberta de métrica que deixou de ser crítica ou perdeu o snapshot: não há o que reavaliar, fica como está
  const orphans = (await instances.listActiveOf(def.id, transaction)).filter((row) => !seen.has(row.metric_code));
  for (const row of orphans) results.push({ alertCode: def.alert_code, metricCode: row.metric_code, action: 'ON_HOLD', reason: 'NO_SNAPSHOT', instanceId: row.id });
  return results;
}

module.exports = { evaluateFreshnessDefinition, FRESHNESS_SCOPE: SCOPE };
