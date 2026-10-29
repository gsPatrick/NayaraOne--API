'use strict';

/**
 * M9-D616 — rm_broker_performance: por corretor e mês (SP), imóveis captados (cadastrados por ele), leads recebidos (oportunidades criadas
 * com ele como responsável) e negócios ganhos (fechadas como ganhas no mês). Captação = created_by do imóvel (DI-D616-3). O agregado é
 * (corretor, mês).
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlMonth } = require('../aggregateModel.sql');
const { params, oneRow, brokerExpr } = require('./support');

const NAME = 'rm_broker_performance';
const EVENTS = ['property.created', 'crm.opportunity.created', 'crm.opportunity.won'];

const slice = ({ where }) => {
  const f = (broker, month) => where({ broker_id: brokerExpr(broker), month: sqlMonth(month) });
  return `
  SELECT broker_id, month, SUM(captured)::int AS captured, SUM(leads_assigned)::int AS leads_assigned, SUM(won)::int AS won FROM (
    SELECT ${brokerExpr('p.created_by')} AS broker_id, ${sqlMonth('p.created_at')} AS month, COUNT(*) AS captured, 0 AS leads_assigned, 0 AS won
      FROM real_estate.properties p WHERE p.company_id = :companyId AND p.deleted_at IS NULL${f('p.created_by', 'p.created_at')} GROUP BY 1, 2
    UNION ALL
    SELECT ${brokerExpr('o.owner_user_id')}, ${sqlMonth('o.created_at')}, 0, COUNT(*), 0
      FROM crm.opportunities o WHERE o.company_id = :companyId AND o.deleted_at IS NULL${f('o.owner_user_id', 'o.created_at')} GROUP BY 1, 2
    UNION ALL
    SELECT ${brokerExpr('o.owner_user_id')}, ${sqlMonth('o.closed_at')}, 0, 0, COUNT(*)
      FROM crm.opportunities o WHERE o.company_id = :companyId AND o.deleted_at IS NULL AND o.stage = 'CLOSED_WON' AND o.closed_at IS NOT NULL${f('o.owner_user_id', 'o.closed_at')} GROUP BY 1, 2
  ) x GROUP BY 1, 2`;
};

async function keyOf(event, { transaction }) {
  const id = (event.payloadJson || event.payload || {}).id;
  if (!id) return null;
  const sql = event.eventType === 'property.created'
    ? `SELECT ${brokerExpr('created_by')}::text AS broker_id, ${sqlMonth('created_at')} AS month FROM real_estate.properties WHERE id = :id AND company_id = :companyId`
    : `SELECT ${brokerExpr('owner_user_id')}::text AS broker_id, ${sqlMonth(event.eventType === 'crm.opportunity.won' ? 'COALESCE(closed_at, created_at)' : 'created_at')} AS month FROM crm.opportunities WHERE id = :id AND company_id = :companyId`;
  const row = await oneRow(sql, { id, companyId: event.companyId }, transaction);
  return row ? { broker_id: row.broker_id, month: row.month } : null;
}

const keysSql = () => `SELECT DISTINCT broker_id::text AS broker_id, month FROM (
  SELECT ${brokerExpr('created_by')} AS broker_id, ${sqlMonth('created_at')} AS month FROM real_estate.properties WHERE company_id = :companyId AND deleted_at IS NULL
  UNION SELECT ${brokerExpr('owner_user_id')}, ${sqlMonth('created_at')} FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL
  UNION SELECT ${brokerExpr('owner_user_id')}, ${sqlMonth('closed_at')} FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage = 'CLOSED_WON' AND closed_at IS NOT NULL) k`;

module.exports = defineAggregateModel({ name: NAME, keyColumns: ['broker_id', 'month'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' } });
