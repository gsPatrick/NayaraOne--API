'use strict';

/**
 * M9-D616 — rm_crm_outcome: desfechos por mês de fechamento (SP) e corretor. A linha de lost_reason vazio traz os totais do mês
 * (ganhas, perdidas e desistências); cada motivo de perda traz a sua contagem em lost_count (motivo ausente = NAO_INFORMADO). O
 * agregado é (mês, corretor). A agenda reconfere os dois últimos meses.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlMonth, TODAY_START } = require('../aggregateModel.sql');
const { params, oneRow, brokerExpr, CLOSED_STAGES } = require('./support');

const NAME = 'rm_crm_outcome';
const EVENTS = ['crm.opportunity.won', 'crm.opportunity.lost', 'crm.opportunity.stage_changed'];
const MONTH = sqlMonth('o.closed_at');

const slice = ({ where }) => {
  const filter = where({ month: MONTH, broker_id: brokerExpr('o.owner_user_id') });
  const base = `FROM crm.opportunities o WHERE o.company_id = :companyId AND o.deleted_at IS NULL AND o.closed_at IS NOT NULL AND o.stage IN (:closedStages)${filter}`;
  return `
  SELECT month, broker_id, lost_reason, SUM(won)::int AS won, SUM(lost)::int AS lost, SUM(withdrawn)::int AS withdrawn, SUM(lost_count)::int AS lost_count FROM (
    SELECT ${MONTH} AS month, ${brokerExpr('o.owner_user_id')} AS broker_id, CAST('' AS text) AS lost_reason,
           COUNT(*) FILTER (WHERE o.stage = 'CLOSED_WON') AS won, COUNT(*) FILTER (WHERE o.stage = 'CLOSED_LOST') AS lost,
           COUNT(*) FILTER (WHERE o.stage = 'WITHDRAWN') AS withdrawn, 0 AS lost_count ${base} GROUP BY 1, 2
    UNION ALL
    SELECT ${MONTH}, ${brokerExpr('o.owner_user_id')}, COALESCE(NULLIF(o.lost_reason, ''), 'NAO_INFORMADO'), 0, 0, 0, COUNT(*)
      ${base} AND o.stage = 'CLOSED_LOST' GROUP BY 1, 2, 3
  ) x GROUP BY 1, 2, 3`;
};

async function keyOf(event, { transaction }) {
  const id = (event.payloadJson || event.payload || {}).id;
  if (!id) return null;
  const row = await oneRow(`SELECT ${sqlMonth('closed_at')} AS month, ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE id = :id AND company_id = :companyId AND closed_at IS NOT NULL`, { id, companyId: event.companyId }, transaction);
  return row ? { month: row.month, broker_id: row.broker_id } : null;
}

const keysSql = ({ full }) => `SELECT DISTINCT ${MONTH} AS month, ${brokerExpr('o.owner_user_id')}::text AS broker_id FROM crm.opportunities o
  WHERE o.company_id = :companyId AND o.deleted_at IS NULL AND o.closed_at IS NOT NULL AND o.stage IN ('${CLOSED_STAGES.join("', '")}')${full ? '' : ` AND o.closed_at >= ${TODAY_START} - interval '62 days'`}`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['month', 'broker_id', 'lost_reason'], aggregateColumns: ['month', 'broker_id'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' },
});
