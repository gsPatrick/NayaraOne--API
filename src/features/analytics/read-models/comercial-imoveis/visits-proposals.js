'use strict';

/**
 * M9-D616 — rm_crm_visits_proposals: por dia (SP), visitas agendadas (fora as canceladas) e realizadas, propostas enviadas (pelo dia do
 * envio) e propostas aceitas (pelo dia da decisão). O agregado é o DIA. A visita agendada não publica evento na criação: a agenda
 * recalcula os últimos analytics.comercial.janela_recalculo_dias dias.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params, oneRow } = require('./support');

const NAME = 'rm_crm_visits_proposals';
const EVENTS = ['crm.visit.completed', 'crm.proposal.created', 'crm.proposal.status_changed'];

const slice = ({ where }) => {
  const f = (col) => where({ day: sqlDay(col) });
  return `
  SELECT day, SUM(vs)::int AS visits_scheduled, SUM(vd)::int AS visits_done, SUM(ps)::int AS proposals_sent, SUM(pa)::int AS proposals_accepted FROM (
    SELECT ${sqlDay('scheduled_at')}::text AS day, COUNT(*) FILTER (WHERE status <> 'CANCELED') AS vs, COUNT(*) FILTER (WHERE status = 'DONE') AS vd, 0 AS ps, 0 AS pa
      FROM crm.visits WHERE company_id = :companyId AND deleted_at IS NULL${f('scheduled_at')} GROUP BY 1
    UNION ALL
    SELECT ${sqlDay('sent_at')}::text, 0, 0, COUNT(*), 0
      FROM crm.proposals WHERE company_id = :companyId AND deleted_at IS NULL AND sent_at IS NOT NULL${f('sent_at')} GROUP BY 1
    UNION ALL
    SELECT ${sqlDay('decided_at')}::text, 0, 0, 0, COUNT(*)
      FROM crm.proposals WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACCEPTED' AND decided_at IS NOT NULL${f('decided_at')} GROUP BY 1
  ) x GROUP BY 1`;
};

async function dayOf(table, column, id, companyId, transaction) {
  const row = await oneRow(`SELECT ${sqlDay(column)}::text AS day FROM ${table} WHERE id = :id AND company_id = :companyId AND ${column} IS NOT NULL`, { id, companyId }, transaction);
  return row ? row.day : null;
}

async function keyOf(event, { transaction }) {
  const p = event.payloadJson || event.payload || {};
  if (!p.id) return null;
  let day = null;
  if (event.eventType === 'crm.visit.completed') day = await dayOf('crm.visits', 'scheduled_at', p.id, event.companyId, transaction);
  else if (p.toStatus === 'ACCEPTED') day = await dayOf('crm.proposals', 'decided_at', p.id, event.companyId, transaction);
  else day = await dayOf('crm.proposals', 'sent_at', p.id, event.companyId, transaction);
  return day ? { day } : null;
}

const keysSql = () => `SELECT DISTINCT day FROM (
  SELECT ${sqlDay('scheduled_at')}::text AS day FROM crm.visits WHERE company_id = :companyId AND deleted_at IS NULL
  UNION SELECT ${sqlDay('sent_at')}::text FROM crm.proposals WHERE company_id = :companyId AND deleted_at IS NULL AND sent_at IS NOT NULL
  UNION SELECT ${sqlDay('decided_at')}::text FROM crm.proposals WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACCEPTED' AND decided_at IS NOT NULL) d`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'recent_days', column: 'day' },
});
