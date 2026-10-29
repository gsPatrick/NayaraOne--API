'use strict';

/**
 * M9-D697 (3.6) — transições de qualidade da métrica por causa dos checks: de OK para DEGRADED publica `analytics.quality.degraded`; de DEGRADED para OK
 * (o refresh seguinte passou nos checks) publica `analytics.quality.recovered`. Um evento por métrica e por refresh, na mesma transação (outbox); repetir
 * a falha ou a aprovação não repete o evento. Nenhum valor é "consertado à mão": o status volta a OK porque a última execução passou.
 */
const logger = require('../../../utils/logger');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { checkQuality } = require('./status.checks');

const DEGRADED_EVENT = 'analytics.quality.degraded';
const RECOVERED_EVENT = 'analytics.quality.recovered';

const metricsOf = (results) => [...new Set(results.flatMap((r) => r.affectedMetricCodes || []))].sort();

/** Map metricCode -> { status, degradedBy } com a última execução de cada check (antes ou depois de gravar a atual). */
async function readStates(results, scope, transaction) {
  const states = new Map();
  for (const code of metricsOf(results)) states.set(code, await checkQuality(code, scope, transaction));
  return states;
}

async function publishTransitions({ input, before, after, transaction }) {
  if (!input.refreshId) return [];
  const published = [];
  for (const [metricCode, now] of after) {
    const was = before.get(metricCode);
    if (!was || was.status === now.status) continue;
    const eventType = now.status === 'DEGRADED' ? DEGRADED_EVENT : RECOVERED_EVENT;
    const checkCodes = (now.status === 'DEGRADED' ? now.degradedBy : was.degradedBy).map((r) => r.checkCode).sort();
    logger.warn({ event: eventType, metricCode, readModel: input.readModel, companyId: input.scope.companyId, checkCodes, refreshId: input.refreshId }, '[analytics] qualidade da métrica mudou');
    await publishDomainEvent({
      groupId: input.scope.groupId, companyId: input.scope.companyId, aggregateType: 'Metric', aggregateId: input.refreshId, eventType, eventVersion: 1, classification: 'INTERNAL',
      payload: { metricCode, readModel: input.readModel, refreshId: input.refreshId, checkCodes },
      idempotencyKey: `${eventType}:${input.refreshId}:${metricCode}`,
    }, transaction);
    published.push({ eventType, metricCode });
  }
  return published;
}

module.exports = { readStates, publishTransitions, DEGRADED_EVENT, RECOVERED_EVENT };
