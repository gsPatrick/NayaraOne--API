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

function parseListQuery(query, defaultPageSize) {
  const q = query || {};
  const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || defaultPageSize, 1), 200);
  const offset = Math.max(Number.parseInt(q.offset, 10) || 0, 0);
  return { status: q.status ? String(q.status).toUpperCase() : null, entityType: q.entityType ? String(q.entityType).toUpperCase() : null, kind: q.kind ? String(q.kind).toUpperCase() : null, limit, offset };
}

module.exports = { parseDecision, parseListQuery, isUuid };
