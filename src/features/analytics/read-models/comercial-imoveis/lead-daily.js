'use strict';

/**
 * M9-D616 — rm_crm_lead_daily: leads por dia (SP), origem e corretor, com a primeira resposta (contagem e soma de segundos; a média é
 * da fórmula do KPI). Lead = oportunidade criada no dia; origem = lead_source; corretor = responsável atual. A primeira resposta é a
 * primeira mensagem de saída depois da criação (a da NAY só conta se analytics.comercial.primeira_resposta_inclui_nay estiver ligado).
 * O agregado é o DIA: o evento recalcula todas as linhas daquele dia.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params, oneRow, opportunityIdOf, brokerExpr } = require('./support');

const NAME = 'rm_crm_lead_daily';
const EVENTS = ['crm.opportunity.created', 'crm.opportunity.stage_changed', 'crm.interaction.recorded'];

const slice = ({ where }) => `
  SELECT ${sqlDay('o.created_at')}::text AS day,
         COALESCE(NULLIF(o.lead_source, ''), 'NAO_INFORMADA') AS origin,
         ${brokerExpr('o.owner_user_id')} AS broker_id,
         COUNT(*)::int AS leads,
         COUNT(fr.first_at)::int AS first_response_count,
         COALESCE(SUM(FLOOR(EXTRACT(EPOCH FROM (fr.first_at - o.created_at)))), 0)::bigint AS first_response_seconds_sum
    FROM crm.opportunities o
    LEFT JOIN LATERAL (
      SELECT MIN(m.created_at) AS first_at FROM crm.messages m
       WHERE m.company_id = o.company_id AND m.opportunity_id = o.id AND m.direction = 'OUTBOUND' AND m.created_at >= o.created_at
         AND (m.author_type = 'EMPLOYEE' OR (CAST(:includeNay AS boolean) AND m.author_type = 'NAY'))
    ) fr ON true
   WHERE o.company_id = :companyId AND o.deleted_at IS NULL${where({ day: sqlDay('o.created_at') })}
   GROUP BY 1, 2, 3`;

async function keyOf(event, { transaction }) {
  const id = opportunityIdOf(event);
  if (!id) return null;
  const row = await oneRow(`SELECT ${sqlDay('created_at')}::text AS day FROM crm.opportunities WHERE id = :id AND company_id = :companyId`, { id, companyId: event.companyId }, transaction);
  return row ? { day: row.day } : null;
}

const keysSql = () => `SELECT DISTINCT ${sqlDay('created_at')}::text AS day FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day', 'origin', 'broker_id'], aggregateColumns: ['day'], eventTypes: EVENTS, keyOf, params, slice, keysSql,
  schedule: { kind: 'recent_days', column: 'day' },
});
