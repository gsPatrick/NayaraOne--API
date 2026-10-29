'use strict';

/**
 * M9-D671 — rm_mkt_optout_month: por mês de São Paulo e canal, os contatos alcançados (pessoas distintas que receberam mensagem de automação ou
 * campanha, com action_key, aceita pelo provedor) e os pedidos de saída (opt-out) do mês. Pedido de saída = pessoa ou endereço distinto com opt-out em
 * marketing.suppression_list (motivo OPT_OUT) ou em people.communication_consents (status OPT_OUT), sem contar a mesma pessoa duas vezes no canal.
 * Pessoas distintas por mês não saem da soma dos dias, por isso o mês é o agregado. `undated` conta os pedidos sem data (a empresa inteira).
 */
const { defineAggregateModel } = require('./aggregateModel');
const { sqlMonth, TODAY_START } = require('./aggregateModel.sql');
const { COUNTED_STATUSES } = require('./marketingAtendimento.statuses');
const { MONTH_RE, monthKey } = require('./marketingAtendimento.time');

const EVENTS = Object.freeze(['customer.opted_out', 'crm.interaction.recorded', 'crm.message.status_changed']);
const SUPPRESSION = `FROM marketing.suppression_list s WHERE s.company_id = :companyId AND s.reason = 'OPT_OUT' AND s.deleted_at IS NULL`;
const CONSENT = `FROM people.communication_consents k WHERE k.company_id = :companyId AND k.status = 'OPT_OUT'`;
const SENT = `FROM crm.messages m WHERE m.company_id = :companyId AND m.direction = 'OUTBOUND' AND m.action_key IS NOT NULL`;
const WHO_S = `COALESCE('p:' || s.person_id::text, 'a:' || s.address_hash)`;

const slice = ({ where }) => `
  SELECT month, channel, SUM(reached)::int AS reached, SUM(opt_outs)::int AS opt_outs, MAX(undated)::int AS undated FROM (
    SELECT ${sqlMonth('m.created_at')} AS month, m.channel, count(DISTINCT m.person_id) AS reached, 0 AS opt_outs, 0 AS undated
      ${SENT} AND m.person_id IS NOT NULL AND m.status IN (:counted)${where({ month: sqlMonth('m.created_at') })} GROUP BY 1, 2
    UNION ALL
    SELECT month, channel, 0, count(DISTINCT who), 0 FROM (
      SELECT ${sqlMonth('s.created_at')} AS month, s.channel, ${WHO_S} AS who ${SUPPRESSION} AND s.created_at IS NOT NULL${where({ month: sqlMonth('s.created_at') })}
      UNION ALL
      SELECT ${sqlMonth('k.recorded_at')}, k.channel, 'p:' || k.person_id::text ${CONSENT} AND k.recorded_at IS NOT NULL${where({ month: sqlMonth('k.recorded_at') })}
    ) o GROUP BY 1, 2
    UNION ALL
    SELECT CAST(:agg_month AS text), channel, 0, 0, count(*) FROM (
      SELECT s.channel ${SUPPRESSION} AND s.created_at IS NULL UNION ALL SELECT k.channel ${CONSENT} AND k.recorded_at IS NULL
    ) u GROUP BY channel
  ) x GROUP BY month, channel`;

async function keyOf(event) {
  const p = event.payloadJson || event.payload || {};
  const month = event.eventType === 'crm.message.status_changed' ? String(p.day || '').slice(0, 7) : monthKey(event.eventType === 'customer.opted_out' ? p.occurredAt || event.occurredAt : event.occurredAt);
  return MONTH_RE.test(month || '') ? { month } : null;
}

const params = async () => ({ counted: COUNTED_STATUSES });

const keysSql = ({ full }) => {
  const since = (col) => (full ? '' : ` AND ${col} >= ${TODAY_START} - interval '62 days'`);
  return `SELECT DISTINCT month FROM (
    SELECT ${sqlMonth('m.created_at')} AS month ${SENT}${since('m.created_at')}
    UNION SELECT ${sqlMonth('s.created_at')} ${SUPPRESSION} AND s.created_at IS NOT NULL${since('s.created_at')}
    UNION SELECT ${sqlMonth('k.recorded_at')} ${CONSENT} AND k.recorded_at IS NOT NULL${since('k.recorded_at')}
  ) x`;
};

module.exports = defineAggregateModel({
  name: 'rm_mkt_optout_month', keyColumns: ['month', 'channel'], aggregateColumns: ['month'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' },
});
