'use strict';

const crypto = require('node:crypto');
const { govError } = require('../governance.errors');
const { SECTOR_CODES, REFERENCE_PATTERN, prefixOf } = require('./bcp.constants');
const { findForm } = require('./bcp.forms.constants');
const { parseOccurredAt } = require('./bcp.time');
const E = require('./bcp.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);

/** Forma do corpo do POST (campos de texto presentes e do tipo certo). O setor vem antes de tudo: é ele que decide quem pode registrar. */
function readSector(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Envie o corpo da requisição em JSON.');
  if (!SECTOR_CODES.includes(body.sector)) throw bad(`O setor deve ser um destes: ${SECTOR_CODES.join(', ')}.`, { field: 'sector' });
  return body.sector;
}

/** Número do formulário válido e do prefixo do setor (M9-D831 §3.1). */
function checkReference(sector, value) {
  const reference = typeof value === 'string' ? value.trim() : '';
  const match = REFERENCE_PATTERN.exec(reference);
  if (!match || match[1] !== prefixOf(sector) || Number(match[3]) === 0) throw E.referenceInvalid();
  return reference;
}

/** Ocorrência do papel: data válida, em horário de Brasília quando sem fuso, e nunca no futuro. */
function checkOccurredAt(value, now = new Date()) {
  const date = parseOccurredAt(value);
  if (!date || date.getTime() > now.getTime()) throw E.dateInvalid();
  return date;
}

/** form_type compatível com o setor e com a intended_action (422 GOV_BCP_ACTION_INVALID). */
function checkFormAndAction(sector, formType, intendedAction) {
  const form = findForm(formType);
  if (!form || form.sector !== sector || form.action !== intendedAction) throw E.actionInvalid();
  return form;
}

function checkCorrelation(value) {
  if (value === undefined || value === null || value === '') return crypto.randomUUID();
  if (typeof value !== 'string' || !UUID.test(value)) throw bad('A referência de correlação deve ser um UUID.', { field: 'correlationRef' });
  return value.toLowerCase();
}

module.exports = { readSector, checkReference, checkOccurredAt, checkFormAndAction, checkCorrelation, UUID };
