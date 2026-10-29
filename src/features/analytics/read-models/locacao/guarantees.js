'use strict';

/**
 * M9-D617 — rm_rental_guarantees: garantias ATIVAS de contratos de locação em vigor (ACTIVE ou SUSPENDED) por tipo, com as que vencem
 * em até 30 e em até 60 dias (acumulado, como as janelas do Financeiro) e as já vencidas. Fim da garantia é data de calendário de São Paulo;
 * vence "hoje" conta como vencendo. A passagem do dia muda os números: a agenda recalcula.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { params } = require('./support');
const { GUARANTEE_EVENTS, CONTRACT_EVENTS } = require('./events');

const within = (days) => `COUNT(*) FILTER (WHERE g.ends_at >= CAST(:today AS date) AND g.ends_at <= CAST(:today AS date) + ${days})::int`;

const slice = () => `
  SELECT g.guarantee_type AS type, ${within(30)} AS expiring_30d, ${within(60)} AS expiring_60d,
         COUNT(*) FILTER (WHERE g.ends_at < CAST(:today AS date))::int AS expired
    FROM legal.guarantees g
    JOIN legal.contracts c ON c.id = g.contract_id AND c.company_id = g.company_id
   WHERE g.company_id = :companyId AND g.deleted_at IS NULL AND g.status = 'ACTIVE' AND g.ends_at IS NOT NULL
     AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes) AND c.status IN (:openStatuses)
   GROUP BY 1`;

module.exports = defineAggregateModel({
  name: 'rm_rental_guarantees', keyColumns: ['type'], aggregateColumns: [], keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
  eventTypes: [...GUARANTEE_EVENTS, ...CONTRACT_EVENTS],
});
