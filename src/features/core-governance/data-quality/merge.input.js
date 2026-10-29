'use strict';

const { DECISIONS } = require('./merge.constants');
const { validation } = require('./data-quality.errors');
const errors = require('./merge.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHOICES = Object.freeze(['SURVIVOR', 'OTHER']);

/** Corpo de POST /data-quality/queue/:id/decision: { decision, survivorId?, note?, evidence?, fieldChoices? }. */
function parseDecision(body) {
  const input = body && typeof body === 'object' ? body : {};
  const decision = typeof input.decision === 'string' ? input.decision.trim().toUpperCase() : '';
  if (!DECISIONS.includes(decision)) throw errors.decisionInvalid();
  const survivorId = typeof input.survivorId === 'string' ? input.survivorId.trim().toLowerCase() : null;
  if (survivorId && !UUID.test(survivorId)) throw validation('O registro mantido (survivorId) é inválido.', { field: 'survivorId' });
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 2000) : null;
  const fieldChoices = {};
  if (input.fieldChoices !== undefined && input.fieldChoices !== null) {
    if (typeof input.fieldChoices !== 'object' || Array.isArray(input.fieldChoices)) throw validation('"fieldChoices" deve ser um objeto campo -> SURVIVOR ou OTHER.', { field: 'fieldChoices' });
    Object.entries(input.fieldChoices).forEach(([field, choice]) => {
      const value = String(choice).toUpperCase();
      if (!CHOICES.includes(value)) throw validation(`A escolha do campo "${field}" deve ser SURVIVOR ou OTHER.`, { field: `fieldChoices.${field}` });
      fieldChoices[field] = value;
    });
  }
  return { decision, survivorId, note, evidence: input.evidence !== undefined ? input.evidence : input.changeEvidence, fieldChoices };
}

const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/** Filtros da fila; a página (page/pageSize) vem de parsePagination (M9-D843). */
function parseListQuery(query, paging) {
  const q = query || {};
  return { status: q.status ? String(q.status).toUpperCase() : null, entityType: q.entityType ? String(q.entityType).toUpperCase() : null, kind: q.kind ? String(q.kind).toUpperCase() : null, limit: paging.limit, offset: paging.offset };
}

module.exports = { parseDecision, parseListQuery, isUuid };
