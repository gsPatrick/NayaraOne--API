'use strict';

/**
 * M9-D616 / M9-D631 — rm_crm_next_action: carteira em andamento por corretor e quantas oportunidades estão sem próxima ação. Oportunidade encerrada
 * não conta. O agregado é o corretor. `without_next_action` (M9-D616) conta o texto vazio; `without_valid_next_action` e `by_stage` (M9-D631)
 * contam as sem próxima ação VÁLIDA: sem tarefa aberta (fora de DONE e CANCELED) com data posterior a hoje e sem próxima ação com texto e data
 * (opportunityNextAction.validator.js). "Posterior a hoje" começa à meia-noite de amanhã em São Paulo; o parâmetro
 * analytics.comercial.proxima_acao_inclui_hoje faz a tarefa de hoje valer também. A tarefa de CRM mora em core.tasks, ligada à oportunidade.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { TODAY_START } = require('../aggregateModel.sql');
const { params, oneRow, brokerExpr, opportunityIdOf, CLOSED_STAGES } = require('./support');

const NAME = 'rm_crm_next_action';
const EVENTS = [
  'crm.opportunity.created', 'crm.opportunity.stage_changed', 'crm.opportunity.won', 'crm.opportunity.lost',
  'crm.task.created', 'crm.task.updated', 'crm.task.completed', 'crm.task.cancelled', 'crm.task.reopened',
];
const TASK_ENTITY = 'crm.opportunities';
const TASK_CLOSED = ['DONE', 'CANCELED'];

const HAS_TEXT = "NULLIF(btrim(COALESCE(o.next_action, '')), '') IS NOT NULL";
const HAS_OPEN_TASK = `EXISTS (
  SELECT 1 FROM core.tasks t
   WHERE t.company_id = o.company_id AND t.related_entity_type = '${TASK_ENTITY}' AND t.related_entity_id = o.id AND t.deleted_at IS NULL
     AND t.status NOT IN ('${TASK_CLOSED.join("', '")}') AND t.due_at >= ${TODAY_START} + make_interval(days => :taskDueOffsetDays))`;
const VALID = `((${HAS_TEXT} AND o.next_action_due_at IS NOT NULL) OR ${HAS_OPEN_TASK})`;

const slice = ({ where }) => `
  SELECT broker_id, SUM(total)::int AS open_total, SUM(without_text)::int AS without_next_action, SUM(without_valid)::int AS without_valid_next_action,
         jsonb_object_agg(stage, jsonb_build_object('open', total, 'without', without_valid)) AS by_stage
    FROM (
      SELECT ${brokerExpr('o.owner_user_id')} AS broker_id, o.stage AS stage, COUNT(*) AS total,
             COUNT(*) FILTER (WHERE NOT ${HAS_TEXT}) AS without_text,
             COUNT(*) FILTER (WHERE NOT ${VALID}) AS without_valid
        FROM crm.opportunities o
       WHERE o.company_id = :companyId AND o.deleted_at IS NULL AND o.stage NOT IN (:closedStages)${where({ broker_id: brokerExpr('o.owner_user_id') })}
       GROUP BY 1, 2
    ) x
   GROUP BY broker_id`;

async function keyOf(event, { transaction }) {
  const id = opportunityIdOf(event);
  if (!id) return null;
  const row = await oneRow(`SELECT ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE id = :id AND company_id = :companyId`, { id, companyId: event.companyId }, transaction);
  return row ? { broker_id: row.broker_id } : null;
}

const keysSql = () => `SELECT DISTINCT ${brokerExpr('owner_user_id')}::text AS broker_id FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage NOT IN ('${CLOSED_STAGES.join("', '")}')`;

module.exports = defineAggregateModel({ name: NAME, keyColumns: ['broker_id'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' } });
