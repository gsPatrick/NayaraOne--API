'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { parseScore } = require('./review.classify');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SOURCE_TYPE = 'SATISFACTION_RESPONSE';

/** Evento original do outbox (a run só lembra identificadores; a nota está no evento): payload e agregado. */
async function outboxEvent(eventId, transaction) {
  if (!UUID_RE.test(String(eventId || ''))) return null;
  const [row] = await sequelize.query('SELECT payload_json, aggregate_id FROM integration.outbox_events WHERE id = :id', { replacements: { id: eventId }, transaction, type: QueryTypes.SELECT });
  return row ? { payload: row.payload_json || {}, aggregateId: row.aggregate_id } : null;
}

/**
 * Fatos da satisfação que originou o pedido: nota (inteira de 1 a 5), origem (tipo e id da resposta da pesquisa, no CRM) e canal da pesquisa. Vêm do payload ao vivo
 * ou, quando a ação é retomada depois (horário de silêncio, replay), do evento original no outbox. Devolve null se não houver nota válida ou origem.
 */
async function satisfactionFacts({ context, transaction }) {
  const live = context && context.payload && context.payload.score !== undefined ? { payload: context.payload, aggregateId: null } : await outboxEvent(context && context.eventId, transaction);
  if (!live) return null;
  const p = live.payload;
  const score = parseScore(p.score);
  const sourceId = [p.sourceEntityId, p.id, live.aggregateId].find((v) => UUID_RE.test(String(v || '')));
  if (score === null || !sourceId) return null;
  return { score, sourceType: String(p.sourceEntityType || DEFAULT_SOURCE_TYPE).slice(0, 80), sourceId, channel: typeof p.channel === 'string' ? p.channel.toUpperCase() : null };
}

module.exports = { satisfactionFacts, DEFAULT_SOURCE_TYPE };
