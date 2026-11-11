'use strict';

/**
 * M9-D616 / M9-D633 — rm_radar_matches: por dia (SP), quantos cruzamentos do Radar (evento radar.matched, um por radar e imóvel) e quantos
 * viraram negócio (a pessoa do radar tem oportunidade GANHA no mesmo imóvel). Para o KPI do BI (M9-D633) o dia traz também quantos já foram
 * avisados (evento publicado ou tratado), quantos geraram visita ou oportunidade (a pessoa do radar tem, no mesmo imóvel, visita não cancelada ou
 * oportunidade criada depois do cruzamento), quantos não têm perfil (radar) ou imóvel ativo, e a contagem por origem do perfil (com oportunidade ou
 * avulso) e por corretor do perfil (quem criou o radar). O agregado é o DIA. Só ids e contagens.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');
const { businessDateKey } = require('../../../../utils/businessDate');

const NAME = 'rm_radar_matches';
const SENT_STATUSES = "'PUBLISHED', 'PROCESSED'";

const slice = ({ where }) => `
  WITH mx AS (
    SELECT ${sqlDay('e.occurred_at')} AS day, e.status IN (${SENT_STATUSES}) AS sent, r.id IS NULL OR pr.id IS NULL AS invalid,
           CASE WHEN r.id IS NULL THEN 'SEM_PERFIL' WHEN r.opportunity_id IS NOT NULL THEN 'COM_OPORTUNIDADE' ELSE 'AVULSO' END AS origin,
           COALESCE(r.created_by::text, CAST(:noBroker AS text)) AS b,
           EXISTS (SELECT 1 FROM crm.opportunities o
                    WHERE o.company_id = e.company_id AND o.deleted_at IS NULL AND o.stage = 'WON'
                      AND o.person_id::text = e.payload_json->>'personId' AND o.property_id::text = e.payload_json->>'propertyId') AS converted,
           EXISTS (SELECT 1 FROM crm.visits v
                    WHERE v.company_id = e.company_id AND v.deleted_at IS NULL AND v.status <> 'CANCELED' AND v.created_at >= e.occurred_at
                      AND v.person_id::text = e.payload_json->>'personId' AND v.property_id::text = e.payload_json->>'propertyId')
           OR EXISTS (SELECT 1 FROM crm.opportunities o
                       WHERE o.company_id = e.company_id AND o.deleted_at IS NULL AND o.created_at >= e.occurred_at
                         AND o.person_id::text = e.payload_json->>'personId' AND o.property_id::text = e.payload_json->>'propertyId') AS turned
      FROM integration.outbox_events e
      LEFT JOIN crm.property_radars r ON r.id::text = e.aggregate_id::text AND r.company_id = e.company_id AND r.deleted_at IS NULL
      LEFT JOIN real_estate.properties pr ON pr.id::text = e.payload_json->>'propertyId' AND pr.company_id = e.company_id
                                         AND pr.deleted_at IS NULL AND COALESCE(pr.publication_status, '') <> 'INACTIVE'
     WHERE e.company_id = :companyId AND e.event_type = 'radar.matched'${where({ day: sqlDay('e.occurred_at') })}),
  agg AS (
    SELECT day, COUNT(*) AS matches, COUNT(*) FILTER (WHERE converted) AS converted, COUNT(*) FILTER (WHERE turned) AS converted_visit_opp, COUNT(*) FILTER (WHERE sent) AS sent, COUNT(*) FILTER (WHERE invalid) AS invalid
      FROM mx GROUP BY 1),
  bo AS (SELECT day, jsonb_object_agg(origin, n) AS by_origin FROM (SELECT day, origin, COUNT(*) AS n FROM mx GROUP BY 1, 2) x GROUP BY 1),
  bb AS (SELECT day, jsonb_object_agg(b, n) AS by_broker FROM (SELECT day, b, COUNT(*) AS n FROM mx GROUP BY 1, 2) x GROUP BY 1)
  SELECT agg.day::text AS day, agg.matches::int AS matches, agg.converted::int AS converted, agg.converted_visit_opp::int AS converted_visit_opp, agg.sent::int AS sent, agg.invalid::int AS invalid,
         COALESCE(bo.by_origin, '{}'::jsonb) AS by_origin, COALESCE(bb.by_broker, '{}'::jsonb) AS by_broker
    FROM agg LEFT JOIN bo ON bo.day = agg.day LEFT JOIN bb ON bb.day = agg.day`;

const keysSql = () => `SELECT DISTINCT ${sqlDay('occurred_at')}::text AS day FROM integration.outbox_events WHERE company_id = :companyId AND event_type = 'radar.matched'`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day'], eventTypes: ['radar.matched'], keyOf: (event, { now }) => ({ day: businessDateKey(event.occurredAt || now) }),
  params, slice, keysSql, schedule: { kind: 'recent_days', column: 'day' },
});
