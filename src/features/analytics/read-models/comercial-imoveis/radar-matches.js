'use strict';

/**
 * M9-D616 — rm_radar_matches: por dia (SP), quantos cruzamentos do Radar (evento radar.matched, um por radar e imóvel) e quantos
 * viraram negócio (a pessoa do radar tem oportunidade GANHA no mesmo imóvel). O agregado é o DIA. Só ids e contagens.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');
const { businessDateKey } = require('../../../../utils/businessDate');

const NAME = 'rm_radar_matches';

const slice = ({ where }) => `
  SELECT ${sqlDay('e.occurred_at')}::text AS day, COUNT(*)::int AS matches,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM crm.opportunities o
            WHERE o.company_id = e.company_id AND o.deleted_at IS NULL AND o.stage = 'CLOSED_WON'
              AND o.person_id::text = e.payload_json->>'personId' AND o.property_id::text = e.payload_json->>'propertyId'))::int AS converted
    FROM integration.outbox_events e
   WHERE e.company_id = :companyId AND e.event_type = 'radar.matched'${where({ day: sqlDay('e.occurred_at') })}
   GROUP BY 1`;

const keysSql = () => `SELECT DISTINCT ${sqlDay('occurred_at')}::text AS day FROM integration.outbox_events WHERE company_id = :companyId AND event_type = 'radar.matched'`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day'], eventTypes: ['radar.matched'], keyOf: (event, { now }) => ({ day: businessDateKey(event.occurredAt || now) }),
  params, slice, keysSql, schedule: { kind: 'recent_days', column: 'day' },
});
