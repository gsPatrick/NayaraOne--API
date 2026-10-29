'use strict';

const { sequelize } = require('../../../../models');
const { consumeInboundEvent } = require('../../../../engines/events/inbox');
const { withUniqueSavepoint } = require('../../../../engines/events/savepoint');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { mapSourceEvent, EVENT_MAPPERS } = require('../sources');
const { readProjectorContext, isCalendarEnabled } = require('./projector.context');
const { applyMapped } = require('./projector.apply');

const CONSUMER = 'governance.calendar.projector';

/** Empresa do contexto da transação (set_config app.company_id) — a que a RLS e a gravação do item enxergam. */
async function sessionCompany(transaction) {
  const [rows] = await sequelize.query("SELECT NULLIF(current_setting('app.company_id', true), '') AS company_id", { transaction });
  return rows[0] ? rows[0].company_id : null;
}

/** Evento de outra empresa: descartado, sem tocar o calendário, e auditado na empresa da sessão (GOV_CALENDAR_TENANT_MISMATCH). */
async function discardMismatch(event, sessionCompanyId, transaction) {
  await registrarAuditoria({
    groupId: event.groupId, companyId: sessionCompanyId, actorUserId: null, action: 'governance.calendar_event.discarded', entityType: 'governance.calendar_event',
    entityId: event.id, beforeJson: null, afterJson: { eventType: event.eventType, eventCompanyId: event.companyId, code: 'GOV_CALENDAR_TENANT_MISMATCH' },
    reason: 'Evento de outra empresa descartado pelo projetor do calendário.',
  }, transaction);
  return { discarded: true, code: 'GOV_CALENDAR_TENANT_MISMATCH' };
}

function toInboxStatus(results) {
  if (results.length && results.every((r) => r.outcome === 'STALE')) return { inboxStatus: 'IGNORED_STALE', reason: 'Evento anterior ao último gravado (occurredAt).' };
  if (results.length && results.every((r) => r.outcome === 'IGNORED_TRANSITION')) return { inboxStatus: 'IGNORED_TRANSITION', reason: 'Transição fora da matriz de status.' };
  return { inboxStatus: 'PROCESSED' };
}

/**
 * Projeta UM evento do outbox no calendário (M9-D802 §3.1 a §3.4). Idempotente pelo inbox (event_id) e pelo UPSERT por origem; roda
 * como savepoint da transação do despacho, então falha em qualquer ponto desfaz item e evento de saída e o evento segue pendente.
 *   event: { id, eventType, groupId, companyId, occurredAt, payloadJson }
 */
async function projectEvent(event, transaction) {
  const tenant = { groupId: event.groupId, companyId: event.companyId };
  const payload = event.payloadJson || event.payload || {};
  const session = await sessionCompany(transaction);
  if ((session && session !== event.companyId) || (payload.companyId && payload.companyId !== event.companyId)) {
    return discardMismatch(event, session || event.companyId, transaction);
  }
  if (!(await isCalendarEnabled(tenant, transaction))) return { skipped: true, reason: 'MODULE_DISABLED' };

  // Tudo ou nada: item, evento de saída, auditoria e registro do inbox voltam juntos se qualquer passo falhar (savepoint de nome único).
  return withUniqueSavepoint(transaction, () => consumeInboundEvent({
    sourceId: CONSUMER, eventId: event.id, groupId: event.groupId, companyId: event.companyId, payload: { eventType: event.eventType }, transaction,
  }, async (inboxTx) => {
    if (!EVENT_MAPPERS[event.eventType]) {
      return { inboxStatus: 'DEAD', reason: `GOV_CALENDAR_EVENT_UNKNOWN: ${event.eventType}` };
    }
    const ctx = await readProjectorContext(tenant, inboxTx);
    const mapped = mapSourceEvent({ id: event.id, eventType: event.eventType, companyId: event.companyId, occurredAt: event.occurredAt, payload }, ctx);
    return toInboxStatus(await applyMapped(tenant, event, mapped, inboxTx));
  }));
}

module.exports = { projectEvent, CONSUMER };
