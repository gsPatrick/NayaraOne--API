'use strict';

/**
 * Regras puras do projetor (M9-D802 §3.2 e §3.2.1), sem banco: estado do item, mescla do rascunho (UPSERT), matriz de transição,
 * desempate e comparação de mudança efetiva.
 */
const { EFFECT } = require('./projector.constants');

const SEVERITY_RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 };
// Desempate de occurredAt igual: DONE vence CANCELLED, que vence OPEN.
const STATUS_RANK = { OPEN: 0, CANCELLED: 1, DONE: 2 };
const TRACKED = ['title', 'ownerUserId', 'ownerTeam', 'dueAt', 'endAt', 'severity', 'status', 'deepLink', 'sourceKind', 'cancelReason'];

const ms = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

/** Linha do banco (snake_case) -> estado. */
function rowToState(row) {
  if (!row) return null;
  return {
    id: row.id, sourceType: row.source_type, sourceId: row.source_id, title: row.title, ownerUserId: row.owner_user_id, ownerTeam: row.owner_team,
    dueAt: row.due_at, endAt: row.end_at, severity: row.severity, status: row.status, deepLink: row.deep_link, sourceKind: row.source_kind,
    cancelReason: row.cancel_reason, lastEventId: row.last_event_id, lastEventOccurredAt: row.last_event_occurred_at, projectionVersion: row.projection_version,
  };
}

/** UPSERT: cria com o estado do rascunho; sobre item existente atualiza os campos e MANTÉM o status (UPSERT não reabre nem fecha). */
function mergeDraft(state, draft) {
  if (!state) {
    return { ...draft, ownerUserId: draft.ownerUserId || null, ownerTeam: draft.ownerTeam || null, endAt: draft.endAt || null, sourceKind: draft.sourceKind || null,
      cancelReason: draft.status === 'CANCELLED' ? draft.cancelReason || null : null, status: draft.status || 'OPEN' };
  }
  if (draft.preserveStatus) {
    // Escalonamento: só sobe a severidade; nada mais muda e item fechado não é reaberto.
    const higher = (SEVERITY_RANK[draft.severity] || 0) > (SEVERITY_RANK[state.severity] || 0);
    return higher ? { ...state, severity: draft.severity } : state;
  }
  return {
    ...state, title: draft.title, ownerUserId: draft.ownerUserId || null, ownerTeam: draft.ownerTeam || null, dueAt: draft.dueAt, endAt: draft.endAt || null,
    severity: draft.severity, deepLink: draft.deepLink, sourceKind: draft.sourceKind || state.sourceKind || null,
  };
}

// Matriz §3.2.1 (evento x status atual): quem pode virar o quê. Fora dela a transição é IGNORED_TRANSITION.
const ALLOWED = { DONE: ['OPEN'], CANCELLED: ['OPEN'], OPEN: ['DONE', 'CANCELLED'] };

/** Aplica um fechamento/reabertura. Devolve { state, effect } com effect APPLIED, NO_ITEM, NOT_ALLOWED ou TIE_LOST. */
function applyTransition(state, transition, { tie = false } = {}) {
  if (!state) return { state, effect: EFFECT.NO_ITEM };
  const target = transition.status;
  if (!(ALLOWED[target] || []).includes(state.status)) return { state, effect: EFFECT.NOT_ALLOWED };
  if (tie && STATUS_RANK[target] <= STATUS_RANK[state.status]) return { state, effect: EFFECT.TIE_LOST };
  return { state: { ...state, status: target, cancelReason: target === 'CANCELLED' ? transition.cancelReason || null : null }, effect: EFFECT.APPLIED };
}

/** Campos que mudaram de verdade: { campo: { antes, apos } }. Data compara por instante; item novo (before nulo) devolve todos. */
function diffStates(before, after) {
  const changes = {};
  for (const field of TRACKED) {
    const a = before ? before[field] : null;
    const b = after[field];
    const same = field === 'dueAt' || field === 'endAt' ? ms(a) === ms(b) : (a ?? null) === (b ?? null);
    if (!same) changes[field] = { antes: field === 'dueAt' || field === 'endAt' ? (a ? new Date(a).toISOString() : null) : a ?? null, apos: field === 'dueAt' || field === 'endAt' ? (b ? new Date(b).toISOString() : null) : b ?? null };
  }
  return changes;
}

/** O evento é mais antigo que o último gravado? (STALE) ou igual (empate)? */
function compareOccurred(state, occurredAt) {
  if (!state || !state.lastEventOccurredAt || !occurredAt) return 'NEWER';
  const stored = ms(state.lastEventOccurredAt);
  const incoming = ms(occurredAt);
  if (incoming < stored) return 'STALE';
  return incoming === stored ? 'TIE' : 'NEWER';
}

module.exports = { rowToState, mergeDraft, applyTransition, diffStates, compareOccurred, TRACKED };
