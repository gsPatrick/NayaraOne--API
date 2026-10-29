'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');
const { EVENT_THRESHOLD } = require('./budgets.constants');

/** ai.budget.threshold_reached no outbox, na mesma transação do consumo. Uma vez por orçamento, limiar e período (chave de idempotência). */
function publishThresholdReached(budget, threshold, pct, transaction) {
  const periodStart = new Date(budget.periodStart).toISOString();
  return publishDomainEvent({
    groupId: budget.groupId,
    companyId: budget.companyId,
    aggregateType: 'AiBudget',
    aggregateId: budget.id,
    eventType: EVENT_THRESHOLD,
    payload: { budgetId: budget.id, threshold, consumedPct: pct, periodStart },
    idempotencyKey: `${EVENT_THRESHOLD}:${budget.id}:${threshold}:${periodStart}`,
  }, transaction);
}

module.exports = { publishThresholdReached };
