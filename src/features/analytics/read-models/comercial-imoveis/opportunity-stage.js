'use strict';

/**
 * M9-D616 — rm_crm_opportunity_stage: oportunidades EM ANDAMENTO por estágio e corretor, e quantas estão paradas (sem movimento há
 * analytics.centro.opp_parada_dias dias; movimento = última edição ou última mensagem). O agregado é o CORRETOR: o evento recalcula todos os
 * estágios dele (a oportunidade que saiu de um estágio e entrou em outro muda duas linhas de uma vez). Reatribuição de corretor não tem
 * evento: a agenda reconfere (a contagem do corretor antigo se corrige na passada seguinte, M9-D616 3.3).
 * M9-D631: idle_days_sum = soma, em dias de calendário de São Paulo, do tempo sem movimento (o mesmo movimento da "parada") das oportunidades da
 * linha; o KPI crm.opportunities_by_stage mostra a média (soma / contagem). A idade muda com o dia: a agenda recalcula todos os corretores.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { TODAY_START, sqlDay } = require('../aggregateModel.sql');
const { params, oneRow, brokerExpr, CLOSED_STAGES } = require('./support');

const NAME = 'rm_crm_opportunity_stage';
const EVENTS = ['crm.opportunity.created', 'crm.opportunity.stage_changed', 'crm.opportunity.won', 'crm.opportunity.lost'];

const slice = ({ where }) => `
  SELECT o.stage AS stage, ${brokerExpr('o.owner_user_id')} AS broker_id,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE GREATEST(o.updated_at, COALESCE(lm.last_at, o.updated_at)) < ${TODAY_START} - make_interval(days => :stalledDays))::int AS stalled_count,
         COALESCE(SUM(GREATEST(0, CAST(:today AS date) - ${sqlDay('GREATEST(o.updated_at, COALESCE(lm.last_at, o.updated_at))')})), 0)::bigint AS idle_days_sum
    FROM crm.opportunities o
    LEFT JOIN LATERAL (SELECT MAX(m.created_at) AS last_at FROM crm.messages m WHERE m.company_id = o.company_id AND m.opportunity_id = o.id) lm ON true
   WHERE o.company_id = :companyId AND o.deleted_at IS NULL AND o.stage NOT IN (:closedStages)${where({ broker_id: brokerExpr('o.owner_user_id') })}
   GROUP BY 1, 2`;

async function keyOf(event, { transaction }) {
  const id = (event.payloadJson || event.payload || {}).id;
  if (!id) return null;
  const row = await oneRow(`SELECT ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE id = :id AND company_id = :companyId`, { id, companyId: event.companyId }, transaction);
  return row ? { broker_id: row.broker_id } : null;
}

const keysSql = () => `SELECT DISTINCT ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage NOT IN ('${CLOSED_STAGES.join("', '")}')`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['stage', 'broker_id'], aggregateColumns: ['broker_id'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' },
});
