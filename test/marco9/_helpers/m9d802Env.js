'use strict';

// Apoio dos testes M9-D802 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const base = require('./m9d803Env');
const { projectEvent } = require('../../../src/features/core-governance/calendar/projector/calendar.projector');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { OutboxEvent } = require('../../../src/models');

const { sequelize } = base;

/** Evento no formato do outbox (o que o despachante entrega ao consumidor). */
function ev(tenant, eventType, payload, occurredAt = '2026-10-20T12:00:00Z', id = randomUUID()) {
  return { id, eventType, groupId: tenant.groupId, companyId: tenant.companyId, occurredAt: new Date(occurredAt), payloadJson: payload };
}

/** Item do calendário por origem (snake_case). */
async function itemOf(tenant, sourceType, sourceId, tx) {
  const rows = await sequelize.query(
    'SELECT * FROM governance.calendar_items WHERE company_id = :companyId AND source_type = :sourceType AND source_id = :sourceId',
    { type: QueryTypes.SELECT, transaction: tx, replacements: { companyId: tenant.companyId, sourceType, sourceId } }
  );
  return rows[0] || null;
}

async function countItems(tenant, sourceType, sourceId, tx) {
  const [{ n }] = await sequelize.query(
    'SELECT count(*)::int AS n FROM governance.calendar_items WHERE company_id = :companyId AND source_type = :sourceType AND source_id = :sourceId',
    { type: QueryTypes.SELECT, transaction: tx, replacements: { companyId: tenant.companyId, sourceType, sourceId } }
  );
  return n;
}

/** Eventos calendar.item.updated de um item. */
const updatedEvents = (itemId, tx) => base.events(itemId, 'calendar.item.updated', tx);

/** Status do inbox do projetor para um evento. */
async function inboxStatus(eventId, tx) {
  const rows = await sequelize.query('SELECT status, dead_letter_reason FROM integration.integration_inbox WHERE event_id = :eventId', { type: QueryTypes.SELECT, transaction: tx, replacements: { eventId } });
  return rows[0] || null;
}

/**
 * Simula o despachante do outbox: entrega a cada consumidor REGISTRADO (runEventConsumers) os eventos PENDING da empresa na
 * ordem de gravação, dentro da transação do teste. Prova a ligação projetor <-> outbox. Devolve os eventos entregues.
 */
async function drain(tenant, tx) {
  const pending = await OutboxEvent.findAll({ where: { companyId: tenant.companyId, status: 'PENDING' }, order: [['created_at', 'ASC']], transaction: tx });
  for (const event of pending) {
    await runEventConsumers(event, tx);
    event.status = 'DISPATCHED';
    await event.save({ transaction: tx });
  }
  return pending;
}

module.exports = { ...base, randomUUID, ev, itemOf, countItems, updatedEvents, inboxStatus, drain, projectEvent, sequelize };
