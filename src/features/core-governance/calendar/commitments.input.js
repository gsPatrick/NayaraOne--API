'use strict';

const { STATUSES } = require('./calendar.constants');
const { UUID } = require('./calendar.query');
const errors = require('./calendar.errors');

const MAX_TITLE = 300;

function parseInstant(value, field) {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw errors.validation(`"${field}" deve ser uma data e hora em formato ISO 8601.`, { field });
  return date;
}

function parseTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > MAX_TITLE) throw errors.validation(`"title" é obrigatório e aceita até ${MAX_TITLE} caracteres.`, { field: 'title' });
  return title;
}

function parseOwner(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw errors.validation('"ownerUserId" deve ser um identificador válido.', { field: 'ownerUserId' });
  return value;
}

function parseStatus(value) {
  if (!STATUSES.includes(value)) throw errors.validation(`"status" deve ser um de: ${STATUSES.join(', ')}.`, { field: 'status' });
  return value;
}

/** Corpo do POST. `endsAt` é opcional (vale o início + duração padrão, parâmetro do administrador). Campos desconhecidos são recusados. */
function parseCreate(body, defaultDurationMin) {
  const b = body && typeof body === 'object' ? body : {};
  const unknown = Object.keys(b).filter((k) => !['title', 'startsAt', 'endsAt', 'ownerUserId'].includes(k));
  if (unknown.length) throw errors.validation(`Campo(s) não aceito(s): ${unknown.join(', ')}.`, { fields: unknown });
  const startsAt = parseInstant(b.startsAt, 'startsAt');
  return {
    title: parseTitle(b.title),
    startsAt,
    endsAt: b.endsAt === undefined || b.endsAt === null ? new Date(startsAt.getTime() + defaultDurationMin * 60000) : parseInstant(b.endsAt, 'endsAt'),
    ownerUserId: b.ownerUserId === undefined ? null : parseOwner(b.ownerUserId),
  };
}

/** Corpo do PATCH: qualquer subconjunto de title, startsAt, endsAt, ownerUserId e status. */
function parsePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const allowed = ['title', 'startsAt', 'endsAt', 'ownerUserId', 'status'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw errors.validation(`Campo(s) não aceito(s): ${unknown.join(', ')}.`, { fields: unknown });
  if (!Object.keys(b).length) throw errors.validation('Informe ao menos um campo para alterar.');
  const patch = {};
  if (b.title !== undefined) patch.title = parseTitle(b.title);
  if (b.startsAt !== undefined) patch.startsAt = parseInstant(b.startsAt, 'startsAt');
  if (b.endsAt !== undefined) patch.endsAt = parseInstant(b.endsAt, 'endsAt');
  if (b.ownerUserId !== undefined) patch.ownerUserId = parseOwner(b.ownerUserId);
  if (b.status !== undefined) patch.status = parseStatus(b.status);
  return patch;
}

module.exports = { parseCreate, parsePatch };
