'use strict';

/**
 * M9-D696 (3.2, 3.4) — fim de cada refresh: roda os checks do read model, grava UMA linha por execução em data_quality_checks (execução
 * repetida grava nova linha, nunca altera a anterior) e, havendo falha BLOCK (ou check em ERROR), marca o refresh como DEGRADED, publica
 * `analytics.quality.check_failed` (na mesma transação, outbox) e deixa o log estruturado. Aviso (WARN) só registra. M9-D697: a mudança de estado da
 * métrica (OK para DEGRADED e a recuperação) publica `analytics.quality.degraded` / `analytics.quality.recovered`.
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { recordQualityCheck } = require('../dataQualityCheckStore.service');
const { executeChecks } = require('./quality.execute');
const { isBlocking } = require('./quality.severity');
const { readStates, publishTransitions } = require('./status.transition');

const EVENT_TYPE = 'analytics.quality.check_failed';
const DEGRADED_CODE = 'ANALYTICS_QUALITY_BLOCKED';

const degrades = (r) => r.status === 'ERROR' || (r.status === 'FAILED' && isBlocking(r.severity));

async function markRefreshDegraded(refreshId, failed, transaction) {
  const codes = failed.map((r) => r.checkCode).join(', ').slice(0, 1800);
  await sequelize.query(
    `UPDATE analytics.read_model_refreshes SET status = 'DEGRADED', error_code = :code, error_message = :message, updated_at = now()
      WHERE id = :id AND status = 'SUCCEEDED'`,
    { replacements: { id: refreshId, code: DEGRADED_CODE, message: `Qualidade: ${codes}` }, transaction }
  );
}

async function publishFailures(input, saved, transaction) {
  for (const r of saved.filter((x) => x.status !== 'PASSED')) {
    logger.warn({ event: EVENT_TYPE, readModel: input.readModel, companyId: input.scope.companyId, checkCode: r.checkCode, checkType: r.checkType, status: r.status, severity: r.severity, refreshId: input.refreshId },
      '[analytics] check de qualidade falhou');
    if (!input.refreshId) continue;
    await publishDomainEvent({
      groupId: input.scope.groupId, companyId: input.scope.companyId, aggregateType: 'ReadModel', aggregateId: input.refreshId, eventType: EVENT_TYPE, eventVersion: 1, classification: 'INTERNAL',
      payload: { readModel: input.readModel, refreshId: input.refreshId, checkCode: r.checkCode, checkType: r.checkType, status: r.status, severity: r.severity, affectedMetricCodes: r.affectedMetricCodes },
      idempotencyKey: `${EVENT_TYPE}:${input.refreshId}:${r.checkCode}`,
    }, transaction);
  }
}

/** Roda, grava e aplica o efeito. Devolve { results, degraded }. Transação própria do chamador (já com o contexto de empresa). */
async function checkRefresh(input, transaction) {
  await enableAnalyticsWriter(transaction);
  const results = await executeChecks(input, transaction);
  const before = input.refreshId ? await readStates(results, input.scope, transaction) : new Map(); // M9-D697: estado das métricas antes desta execução
  for (const r of results) {
    await recordQualityCheck({ ...r, readModel: input.readModel, companyId: input.scope.companyId, groupId: input.scope.groupId, refreshId: input.refreshId || undefined }, input.scope, transaction);
  }
  const failed = results.filter(degrades);
  if (failed.length && input.refreshId) await markRefreshDegraded(input.refreshId, failed, transaction);
  await publishFailures(input, results, transaction);
  await publishTransitions({ input, before, after: input.refreshId ? await readStates(results, input.scope, transaction) : new Map(), transaction });
  return { results, degraded: failed.length > 0 };
}

module.exports = { checkRefresh, EVENT_TYPE, DEGRADED_CODE };
