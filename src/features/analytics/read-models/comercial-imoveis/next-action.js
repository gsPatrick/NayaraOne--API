'use strict';

/**
 * M9-D616 — rm_crm_next_action: carteira em andamento por corretor e quantas oportunidades estão sem próxima ação registrada (texto
 * vazio). Oportunidade encerrada não conta. O agregado é o corretor.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { params, oneRow, brokerExpr, CLOSED_STAGES } = require('./support');

const NAME = 'rm_crm_next_action';
const EVENTS = ['crm.opportunity.created', 'crm.opportunity.stage_changed', 'crm.opportunity.won', 'crm.opportunity.lost'];

const slice = ({ where }) => `
  SELECT ${brokerExpr('o.owner_user_id')} AS broker_id, COUNT(*)::int AS open_total,
         COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(o.next_action, '')), '') IS NULL)::int AS without_next_action
    FROM crm.opportunities o
   WHERE o.company_id = :companyId AND o.deleted_at IS NULL AND o.stage NOT IN (:closedStages)${where({ broker_id: brokerExpr('o.owner_user_id') })}
   GROUP BY 1`;

async function keyOf(event, { transaction }) {
  const id = (event.payloadJson || event.payload || {}).id;
  if (!id) return null;
  const row = await oneRow(`SELECT ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE id = :id AND company_id = :companyId`, { id, companyId: event.companyId }, transaction);
  return row ? { broker_id: row.broker_id } : null;
}

const keysSql = () => `SELECT DISTINCT ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage NOT IN ('${CLOSED_STAGES.join("', '")}')`;

module.exports = defineAggregateModel({ name: NAME, keyColumns: ['broker_id'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' } });
