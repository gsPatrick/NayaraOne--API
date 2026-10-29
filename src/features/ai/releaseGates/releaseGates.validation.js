'use strict';

const E = require('./releaseGates.errors');
const { ITEMS, SCOPE_OF_ITEM, SCOPE, STATUS, EVIDENCE_REQUIRED } = require('./releaseGates.constants');

const REF = /^[A-Za-z0-9_.-]{1,64}$/;
const LEVELS = ['COMPANY', 'GROUP'];
const KEY = /^[\x21-\x7e]{1,200}$/;

const text = (value, field, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw E.invalid(`${field} deve ser um texto de até ${max} caracteres.`, { field });
  return value.trim() || null;
};

/** Corpo do POST: item (obrigatório), scopeRef (agente ou provedor), status, evidenceRef, notes, level e idempotencyKey. */
function parseRegister(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw E.invalid('Corpo da requisição inválido.');
  if (!ITEMS.includes(raw.item)) throw E.invalid(`O item deve ser um destes: ${ITEMS.join(', ')}.`, { field: 'item' });
  const scopeType = SCOPE_OF_ITEM[raw.item];
  let scopeRef = null;
  if (scopeType === SCOPE.GLOBAL) {
    if (raw.scopeRef !== undefined && raw.scopeRef !== null && raw.scopeRef !== '') throw E.invalid(`${raw.item} vale para a NAY toda e não aceita scopeRef.`, { field: 'scopeRef' });
  } else {
    if (typeof raw.scopeRef !== 'string' || !REF.test(raw.scopeRef.trim())) throw E.invalid(`Informe em scopeRef o código ${scopeType === SCOPE.AGENT ? 'do agente' : 'do provedor'}.`, { field: 'scopeRef' });
    scopeRef = scopeType === SCOPE.AGENT ? raw.scopeRef.trim().toUpperCase() : raw.scopeRef.trim().toLowerCase();
  }
  const status = raw.status === undefined ? STATUS.PENDING : raw.status;
  if (!Object.values(STATUS).includes(status)) throw E.invalid('O status deve ser PENDING, APPROVED ou REJECTED.', { field: 'status' });
  const level = raw.level === undefined ? 'COMPANY' : raw.level;
  if (!LEVELS.includes(level)) throw E.invalid('O nível deve ser COMPANY ou GROUP.', { field: 'level' });
  const evidenceRef = text(raw.evidenceRef, 'evidenceRef', 500);
  if (status === STATUS.APPROVED && EVIDENCE_REQUIRED.includes(raw.item) && !evidenceRef) throw E.evidenceRequired(raw.item);
  const idempotencyKey = raw.idempotencyKey === undefined || raw.idempotencyKey === null ? null : String(raw.idempotencyKey);
  if (idempotencyKey !== null && !KEY.test(idempotencyKey)) throw E.invalid('Idempotency-Key inválida.', { field: 'idempotencyKey' });
  return { item: raw.item, scopeType, scopeRef, status, level, evidenceRef, notes: text(raw.notes, 'notes', 2000), idempotencyKey };
}

module.exports = { parseRegister };
