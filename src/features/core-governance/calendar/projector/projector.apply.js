'use strict';

const { upsertItem, lockItem, touchLastEvent } = require('../calendar.projection.store');
const { publishDomainEvent } = require('../../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { rowToState, mergeDraft, applyTransition, diffStates, compareOccurred } = require('./projector.state');

const AGGREGATE = 'CalendarItem';

/** Chaves (tipo, origem) tocadas pelo resultado do mapeamento, na ordem de aparição. */
function keysOf(mapped) {
  const seen = new Map();
  for (const entry of [...mapped.items, ...mapped.transitions]) seen.set(`${entry.sourceType}:${entry.sourceId}`, { sourceType: entry.sourceType, sourceId: entry.sourceId });
  return [...seen.values()];
}

/** Um item da origem: trava, decide pelo estado atual (ordem, matriz e desempate) e grava + publica só se houve mudança efetiva. */
async function applyKey(tenant, event, key, mapped, transaction) {
  const existing = rowToState(await lockItem(tenant, key.sourceType, key.sourceId, transaction));
  const order = compareOccurred(existing, event.occurredAt);
  if (order === 'STALE') return { outcome: 'STALE', key };
  let next = existing;
  const effects = [];
  for (const draft of mapped.items.filter((d) => d.sourceType === key.sourceType && d.sourceId === key.sourceId)) next = mergeDraft(next, draft);
  for (const tr of mapped.transitions.filter((t) => t.sourceType === key.sourceType && t.sourceId === key.sourceId)) {
    const result = applyTransition(next, tr, { tie: order === 'TIE' });
    next = result.state;
    effects.push(result.effect);
  }
  // Item criado já cancelado (evento de cancelamento chegou antes de qualquer UPSERT): o motivo vem da transição.
  const cancelReason = mapped.transitions.find((t) => t.sourceType === key.sourceType && t.sourceId === key.sourceId && t.status === 'CANCELLED');
  if (next && next.status === 'CANCELLED' && !next.cancelReason && cancelReason) next = { ...next, cancelReason: cancelReason.cancelReason };
  const changes = next ? diffStates(existing, next) : {};
  if (!next || !Object.keys(changes).length) {
    if (existing && order === 'NEWER') await touchLastEvent(existing.id, event.id, event.occurredAt, transaction);
    const ignored = effects.length > 0 && effects.every((e) => e !== 'APPLIED');
    return { outcome: ignored ? 'IGNORED_TRANSITION' : 'UNCHANGED', key, effects };
  }
  const row = await upsertItem(tenant, { ...next, lastEventId: event.id, lastEventOccurredAt: event.occurredAt }, transaction);
  await publishDomainEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: AGGREGATE, aggregateId: row.id, eventType: 'calendar.item.updated',
    payload: { itemId: row.id, sourceType: key.sourceType, sourceId: key.sourceId, changes },
    idempotencyKey: `calendar.item.updated:${row.id}:${row.projection_version}`,
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'governance.calendar_item.project', entityType: 'governance.calendar_item',
    entityId: row.id, beforeJson: existing, afterJson: rowToState(row), reason: `Evento ${event.eventType} projetado no calendário.`,
  }, transaction);
  return { outcome: 'APPLIED', key, itemId: row.id, changes };
}

async function applyMapped(tenant, event, mapped, transaction) {
  const results = [];
  for (const key of keysOf(mapped)) results.push(await applyKey(tenant, event, key, mapped, transaction));
  return results;
}

/** Fechamento em lote da varredura diária (M9-D803): o item já foi gravado; aqui só sai o calendar.item.updated com antes e depois do status. */
async function announceStatusChange(tenant, row, to, transaction) {
  return publishDomainEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: AGGREGATE, aggregateId: row.id, eventType: 'calendar.item.updated',
    payload: { itemId: row.id, sourceType: row.source_type, sourceId: row.source_id, changes: { status: { antes: 'OPEN', apos: to } } },
    idempotencyKey: `calendar.item.updated:${row.id}:${row.projection_version}`,
  }, transaction);
}

module.exports = { applyMapped, applyKey, keysOf, announceStatusChange };
