'use strict';

/**
 * M9-D617 / M9-D641 — rm_rental_guarantees: garantias ATIVAS de contratos de locação ACTIVE por tipo, com as que vencem em 30 dias (de hoje até hoje+29), em 60 dias (de hoje até hoje+59,
 * acumulado como as janelas do Financeiro) e as já vencidas. Fim da garantia é data de calendário de São Paulo; vence "hoje" conta como vencendo. A passagem do dia muda os números: a
 * agenda recalcula. Garantia sem data de vencimento conta em without_date, exceto os tipos sem vencimento (analytics.locacao.garantias_sem_vencimento, padrão DEPOSIT), que ficam de fora.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { params } = require('./support');
const { GUARANTEE_EVENTS, CONTRACT_EVENTS } = require('./events');
const { readNoExpiryGuaranteeTypes } = require('../locacaoPrazosKpi.settings');

const within = (days) => `COUNT(*) FILTER (WHERE g.ends_at >= CAST(:today AS date) AND g.ends_at <= CAST(:today AS date) + ${days})::int`;

const slice = () => `
  SELECT g.guarantee_type AS type, ${within(29)} AS expiring_30d, ${within(59)} AS expiring_60d,
         COUNT(*) FILTER (WHERE g.ends_at < CAST(:today AS date))::int AS expired, COUNT(*) FILTER (WHERE g.ends_at IS NULL)::int AS without_date
    FROM legal.guarantees g
    JOIN legal.contracts c ON c.id = g.contract_id AND c.company_id = g.company_id
   WHERE g.company_id = :companyId AND g.deleted_at IS NULL AND g.status = 'ACTIVE' AND (g.ends_at IS NOT NULL OR g.guarantee_type NOT IN (:noExpiryTypes))
     AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes) AND c.status = 'ACTIVE'
   GROUP BY 1`;

module.exports = defineAggregateModel({
  name: 'rm_rental_guarantees', keyColumns: ['type'], aggregateColumns: [], keyOf: () => ({}), slice, schedule: { kind: 'keys' },
  params: async (scope, transaction) => ({ ...(await params(scope, transaction)), noExpiryTypes: await readNoExpiryGuaranteeTypes(scope, transaction) }),
  eventTypes: [...GUARANTEE_EVENTS, ...CONTRACT_EVENTS],
});
