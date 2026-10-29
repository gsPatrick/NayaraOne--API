'use strict';

/**
 * M9-D619 — read model rm_fin_provider_outcome (schema analytics): por provider, produto e MÊS DA DECISÃO (calendário de São Paulo), as aprovações, as
 * rejeições, a soma das horas de análise e quantas decisões têm hora de análise. Decisão = primeiro registro aplicado do histórico do provider com status
 * APPROVED ou REJECTED de cada caso; envio = primeiro registro aplicado SUBMITTED do caso, ou o primeiro envio ao provider; sem data de envio a decisão
 * conta mas não entra nas horas (o KPI compara `approved + rejected` com `analysis_count` e marca DEGRADED, M9-D661). Pendentes não entram. O agregado é
 * o mês da decisão. Só provider, produto, mês e totais; solicitante e valores do caso não entram.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const clock = require('../metrics/clock');
const { OUTCOME_EVENTS } = require('./juridico.events');
const { BUSINESS_TIMEZONE, businessDateKey } = require('../../../utils/businessDate');

const DECISIONS = `
  SELECT DISTINCT ON (h.financing_case_id) h.financing_case_id, h.normalized_status AS outcome, h.occurred_at AS decided_at
    FROM correspondent.provider_status_history h
   WHERE h.company_id = :companyId AND h.applied AND h.normalized_status IN ('APPROVED', 'REJECTED')
   ORDER BY h.financing_case_id, h.occurred_at, h.id`;

/** Mês (AAAA-MM, SP) da decisão do caso do evento; sem histórico, o mês do próprio evento. */
async function aggregateKey(event, { transaction }) {
  const payload = event.payloadJson || event.payload || {};
  const [rows] = await sequelize.query(`WITH d AS (${DECISIONS}) SELECT to_char((decided_at AT TIME ZONE :tz)::date, 'YYYY-MM') AS month FROM d WHERE financing_case_id = :caseId`, {
    replacements: { companyId: event.companyId, caseId: payload.id, tz: BUSINESS_TIMEZONE }, transaction,
  });
  return { period_month: rows.length ? rows[0].month : businessDateKey(event.occurredAt || clock.now()).slice(0, 7) };
}

async function recompute({ companyId, key, transaction }) {
  const [rows] = await sequelize.query(
    `WITH d AS (${DECISIONS}),
     s AS (SELECT financing_case_id, min(at) AS sent_at FROM (
             SELECT financing_case_id, occurred_at AS at FROM correspondent.provider_status_history WHERE company_id = :companyId AND applied AND normalized_status = 'SUBMITTED'
             UNION ALL SELECT financing_case_id, created_at FROM correspondent.provider_submissions WHERE company_id = :companyId AND status = 'SUBMITTED') x GROUP BY 1)
     SELECT fc.provider_code AS provider, fc.product,
            (count(*) FILTER (WHERE d.outcome = 'APPROVED'))::int AS approved, (count(*) FILTER (WHERE d.outcome = 'REJECTED'))::int AS rejected,
            ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM GREATEST(d.decided_at - s.sent_at, interval '0')) / 3600) FILTER (WHERE s.sent_at IS NOT NULL), 0)::numeric, 2)::text AS analysis_hours_sum,
            (count(*) FILTER (WHERE s.sent_at IS NOT NULL))::int AS analysis_count,
            (COALESCE(SUM(GREATEST(0, (d.decided_at AT TIME ZONE :tz)::date - (s.sent_at AT TIME ZONE :tz)::date)) FILTER (WHERE s.sent_at IS NOT NULL), 0))::int AS analysis_days_sum
       FROM d JOIN correspondent.financing_cases fc ON fc.id = d.financing_case_id AND fc.company_id = :companyId LEFT JOIN s ON s.financing_case_id = d.financing_case_id
      WHERE to_char((d.decided_at AT TIME ZONE :tz)::date, 'YYYY-MM') = :month GROUP BY 1, 2 ORDER BY 1, 2`,
    { replacements: { companyId, month: key.period_month, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { rows: rows.map(({ provider, product, ...fields }) => ({ key: { provider, product }, fields })) };
}

async function rebuildKeys({ companyId, transaction }) {
  const [rows] = await sequelize.query(`WITH d AS (${DECISIONS}) SELECT DISTINCT to_char((decided_at AT TIME ZONE :tz)::date, 'YYYY-MM') AS period_month FROM d ORDER BY 1`, {
    replacements: { companyId, tz: BUSINESS_TIMEZONE }, transaction,
  });
  return rows;
}

const def = registerReadModel({
  name: 'rm_fin_provider_outcome',
  version: 1,
  keyColumns: ['provider', 'product', 'period_month'],
  aggregateColumns: ['period_month'],
  eventTypes: [...OUTCOME_EVENTS],
  aggregateKey,
  recompute,
  rebuild: { keys: rebuildKeys },
});

module.exports = { def, recompute };
