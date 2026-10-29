'use strict';

/**
 * M9-D617 — rm_rental_tickets (um retrato por empresa e data-base): chamados de manutenção dos imóveis com contrato de locação. Abertos e
 * fechados NO DIA da data-base (SP), em aberto agora (OPEN, IN_PROGRESS) e a soma das horas de resolução dos fechados no dia (a média é da
 * fórmula do KPI). O fechamento é o instante da última atualização do chamado RESOLVED ou CLOSED (o cadastro não guarda o instante
 * do fechamento: DI-D617-6).
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params, todayKey, LEASE_IDS } = require('./support');
const { TICKET_EVENTS } = require('./events');

const CLOSED = `m.status IN ('RESOLVED', 'CLOSED')`;

const slice = () => `
  SELECT COUNT(*) FILTER (WHERE ${sqlDay('m.created_at')} = CAST(:today AS date))::int AS opened,
         COUNT(*) FILTER (WHERE ${CLOSED} AND ${sqlDay('m.updated_at')} = CAST(:today AS date))::int AS closed,
         COUNT(*) FILTER (WHERE m.status IN ('OPEN', 'IN_PROGRESS'))::int AS open_total,
         COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (m.updated_at - m.created_at)) / 3600) FILTER (WHERE ${CLOSED} AND ${sqlDay('m.updated_at')} = CAST(:today AS date)), 2), 0) AS resolution_hours_sum
    FROM construction.maintenance_cases m
   WHERE m.company_id = :companyId AND m.deleted_at IS NULL
     AND m.property_id IN (SELECT lc.property_id FROM legal.contracts lc WHERE lc.id IN ${LEASE_IDS} AND lc.property_id IS NOT NULL)`;

module.exports = defineAggregateModel({
  name: 'rm_rental_tickets', keyColumns: ['as_of_date'], eventTypes: [...TICKET_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
