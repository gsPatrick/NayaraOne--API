'use strict';

/**
 * M9-D616 / M9-D632 — rm_crm_visits_proposals: por dia (SP), visitas agendadas (fora as canceladas) e realizadas, propostas enviadas (pelo dia do
 * envio) e propostas aceitas (pelo dia da decisão). Para o KPI do BI (M9-D632) o mesmo dia traz também: visitas sem corretor e por corretor; as
 * propostas ENVIADAS no dia (coorte do dia do envio) por desfecho de hoje (aceita, recusada, expirada, em aberto), o valor proposto, as sem valor
 * e as por corretor da oportunidade. A coorte muda quando a proposta é decidida em outro dia, por isso o agregado é a EMPRESA inteira (poucas
 * linhas: um dia por linha); qualquer evento recalcula todos os dias e a agenda reconfere sem janela de dias. A visita agendada não publica
 * evento na criação: a agenda a recalcula.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');

const NAME = 'rm_crm_visits_proposals';
const EVENTS = ['crm.visit.completed', 'crm.proposal.created', 'crm.proposal.status_changed'];

const slice = () => `
  WITH vb AS (
    SELECT ${sqlDay('v.scheduled_at')} AS day, COALESCE(v.agent_user_id::text, CAST(:noBroker AS text)) AS b,
           COUNT(*) FILTER (WHERE v.status <> 'CANCELED') AS s, COUNT(*) FILTER (WHERE v.status = 'DONE') AS d
      FROM crm.visits v WHERE v.company_id = :companyId AND v.deleted_at IS NULL GROUP BY 1, 2),
  vt AS (
    SELECT day, SUM(s) AS s, SUM(d) AS d, COALESCE(SUM(s) FILTER (WHERE b = CAST(:noBroker AS text)), 0) AS nb,
           COALESCE(jsonb_object_agg(b, jsonb_build_object('s', s, 'd', d)) FILTER (WHERE s > 0), '{}'::jsonb) AS by_broker
      FROM vb GROUP BY 1),
  px AS (
    SELECT pr.id, pr.status, pr.value, pr.decided_at, ${sqlDay('pr.sent_at')} AS day, COALESCE(o.owner_user_id::text, CAST(:noBroker AS text)) AS b
      FROM crm.proposals pr LEFT JOIN crm.opportunities o ON o.id = pr.opportunity_id AND o.company_id = pr.company_id
     WHERE pr.company_id = :companyId AND pr.deleted_at IS NULL AND pr.sent_at IS NOT NULL),
  pbk AS (SELECT day, b, COUNT(*) AS n FROM px GROUP BY 1, 2),
  pt AS (
    SELECT day, COUNT(*) AS sent, COUNT(*) FILTER (WHERE status = 'ACCEPTED') AS acc, COUNT(*) FILTER (WHERE status = 'REJECTED') AS rej,
           COUNT(*) FILTER (WHERE status = 'EXPIRED') AS exp, COUNT(*) FILTER (WHERE status IN ('SENT', 'UNDER_NEGOTIATION')) AS opn,
           COALESCE(SUM(value), 0) AS val, COUNT(*) FILTER (WHERE value IS NULL OR value <= 0) AS nov
      FROM px GROUP BY 1),
  pbj AS (SELECT day, jsonb_object_agg(b, n) AS by_broker FROM pbk GROUP BY 1),
  pa AS (
    SELECT ${sqlDay('decided_at')} AS day, COUNT(*) AS acc FROM crm.proposals
     WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACCEPTED' AND decided_at IS NOT NULL GROUP BY 1),
  days AS (SELECT day FROM vt UNION SELECT day FROM pt UNION SELECT day FROM pa)
  SELECT days.day::text AS day,
         COALESCE(vt.s, 0)::int AS visits_scheduled, COALESCE(vt.d, 0)::int AS visits_done, COALESCE(pt.sent, 0)::int AS proposals_sent,
         COALESCE(pa.acc, 0)::int AS proposals_accepted, COALESCE(vt.nb, 0)::int AS visits_no_broker, COALESCE(vt.by_broker, '{}'::jsonb) AS visits_by_broker,
         COALESCE(pt.acc, 0)::int AS proposals_sent_accepted, COALESCE(pt.rej, 0)::int AS proposals_sent_rejected, COALESCE(pt.exp, 0)::int AS proposals_sent_expired,
         COALESCE(pt.opn, 0)::int AS proposals_sent_open, COALESCE(pt.val, 0) AS proposals_sent_value, COALESCE(pt.nov, 0)::int AS proposals_sent_no_value,
         COALESCE(pbj.by_broker, '{}'::jsonb) AS proposals_by_broker
    FROM days LEFT JOIN vt ON vt.day = days.day LEFT JOIN pt ON pt.day = days.day LEFT JOIN pa ON pa.day = days.day LEFT JOIN pbj ON pbj.day = days.day`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day'], aggregateColumns: [], eventTypes: EVENTS, keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
});
