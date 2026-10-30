'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { registerEventConsumer } = require('../../../../engines/events/consumers');

const CONSUMER = 'marketing.reminder_pendings';
const KINDS = ['DOCUMENT', 'RESTRICTION', 'REGULARIZATION'];
const SOURCES = ['OPPORTUNITY', 'FINANCING', 'CONTRACT'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REF = 80; // o eventId sintético da agenda (sched:fluxo:pendência:data) cabe nos 160 caracteres da run
const ref = (payload) => String(payload.pendingId || payload.id || '').trim();
const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

const setTenant = (event, transaction) => sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: event.groupId, c: event.companyId }, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/**
 * crm.pending.opened — a pendência entra na lista que a série de lembretes acompanha. Payload: { pendingId, personId, kind (DOCUMENT, RESTRICTION, REGULARIZATION),
 * sourceType (OPPORTUNITY, FINANCING, CONTRACT), sourceId, responsibleUserId, openedAt }. Só o tipo é guardado, nunca o motivo. Evento repetido não duplica (UNIQUE empresa+pendência);
 * evento sem pessoa da empresa ou fora do contrato é ignorado e registrado no log técnico (o retry do outbox não ajudaria).
 */
async function onOpened(event, transaction) {
  await setTenant(event, transaction);
  const p = event.payloadJson || {};
  const personId = uuidOrNull(p.personId);
  const pendingRef = ref(p);
  const person = personId && await run('SELECT 1 AS ok FROM people.persons WHERE id = :id AND company_id = :c AND deleted_at IS NULL', { id: personId, c: event.companyId }, transaction);
  if (!pendingRef || pendingRef.length > MAX_REF || !person || !person.length || !KINDS.includes(p.kind) || !SOURCES.includes(p.sourceType)) {
    logger.warn({ eventId: event.id, code: 'MKT_PENDING_EVENT_INVALID' }, 'marketing.reminder_pending.ignored');
    return { ignored: true };
  }
  const openedAt = p.openedAt && !Number.isNaN(new Date(p.openedAt).getTime()) ? new Date(p.openedAt) : new Date(event.occurredAt || event.createdAt || Date.now());
  await run(
    `INSERT INTO marketing.reminder_pendings (group_id, company_id, pending_ref, person_id, kind, source_type, source_id, responsible_user_id, opened_at)
     VALUES (:g, :c, :ref, :person, :kind, :st, :sid, :resp, :at) ON CONFLICT (company_id, pending_ref) DO NOTHING RETURNING id`,
    { g: event.groupId, c: event.companyId, ref: pendingRef, person: personId, kind: p.kind, st: p.sourceType, sid: uuidOrNull(p.sourceId), resp: uuidOrNull(p.responsibleUserId), at: openedAt }, transaction
  );
  return { opened: true };
}

/** Fecha a pendência (RESOLVED ou CANCELLED) na hora: o próximo tick não envia mais nada. Pendência já fechada ou desconhecida não muda. */
const closer = (status) => async (event, transaction) => {
  await setTenant(event, transaction);
  const rows = await run(
    `UPDATE marketing.reminder_pendings SET status = :status, closed_at = now(), updated_at = now() WHERE company_id = :c AND pending_ref = :ref AND status = 'OPEN' RETURNING id`,
    { status, c: event.companyId, ref: ref(event.payloadJson || {}) }, transaction
  );
  return { closed: rows.length };
};

const PENDING_EVENTS = Object.freeze({ 'crm.pending.opened': onOpened, 'crm.pending.resolved': closer('RESOLVED'), 'crm.pending.cancelled': closer('CANCELLED') });
for (const [eventType, handler] of Object.entries(PENDING_EVENTS)) registerEventConsumer(eventType, CONSUMER, handler);

module.exports = { CONSUMER, PENDING_EVENTS, onOpened };
