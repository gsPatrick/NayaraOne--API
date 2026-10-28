'use strict';

const { severityFor } = require('../calendar.severity');

const TITLE_MAX = 300;

/** Título do item: sem quebra de linha, no máximo 300 caracteres (limite da coluna). */
function clipTitle(text, fallback) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim() || fallback;
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

/** Resultado vazio de um mapeamento: itens a gravar (UPSERT) e fechamentos (transições do M9-D802 §3.2.1). */
function emptyResult() {
  return { items: [], transitions: [] };
}

function transition(sourceType, sourceId, status, cancelReason = null) {
  return { sourceType, sourceId, status, cancelReason };
}

function itemDraft(ctx, fields) {
  return {
    status: 'OPEN',
    severity: severityFor(fields.sourceType, ctx.severityMap),
    lastEventId: ctx.event ? ctx.event.id || null : null,
    lastEventOccurredAt: ctx.event ? ctx.event.occurredAt || null : null,
    ...fields,
  };
}

module.exports = { clipTitle, emptyResult, transition, itemDraft };
