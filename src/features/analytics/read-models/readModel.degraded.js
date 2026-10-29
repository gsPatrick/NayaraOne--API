'use strict';

/**
 * M9-D607 (4, falha persistente) — evento que esgotou as tentativas vai para a DLQ do outbox e o read model fica DEGRADED: uma linha
 * de refresh com esse status (a mais recente por read model manda; o refresh seguinte bem-sucedido a supera). Gravada em transação
 * PRÓPRIA, porque a do despacho é desfeita pela falha. O "alerta técnico" é o log de erro estruturado `analytics.read_model.degraded`;
 * o alerta de BI (alert_instances) nasce das regras de freshness e qualidade (M9-D696/D697) a partir desta linha.
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { startRefresh, finishRefresh } = require('../readModelRefreshStore.service');

async function markDegraded(event, models, error) {
  const errorCode = (error && error.code) || 'READ_MODEL_EVENT_FAILED';
  const ctx = { companyId: event.companyId, groupId: event.groupId };
  await sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: event.groupId, c: event.companyId }, transaction: t });
    await enableAnalyticsWriter(t);
    for (const def of models) {
      const row = await startRefresh({ groupId: event.groupId, companyId: event.companyId, readModel: def.name, trigger: 'EVENT', version: def.version }, ctx, t);
      await finishRefresh(row.id, { status: 'DEGRADED', errorCode: String(errorCode).slice(0, 80), errorMessage: error && error.message, lastSourceEventId: event.id }, ctx, t);
    }
  });
  logger.error({ event: 'analytics.read_model.degraded', readModels: models.map((m) => m.name), companyId: event.companyId, sourceEventId: event.id, errorCode },
    '[analytics] read model DEGRADED: evento esgotou as tentativas e foi para a DLQ');
}

module.exports = { markDegraded };
