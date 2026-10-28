'use strict';

const { SOURCE_TYPES, STATUSES, MAX_PAGE_SIZE } = require('./calendar.constants');
const { zonedToUtc, endOfDayPlus, defaultWindow } = require('./calendar.window');
const errors = require('./calendar.errors');

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "A,B" ou ['A', 'B,C'] -> ['A','B','C'] (aceita o parâmetro repetido e a lista separada por vírgula). */
function toList(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
}

/** Data ISO (com hora) ou só o dia (vale 00:00, ou 23:59:59 quando é o fim, em America/Sao_Paulo). */
function parseBoundary(text, name, isEnd) {
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw errors.validation(`Data inválida em "${name}": use o formato AAAA-MM-DD ou ISO 8601.`, { field: name });
    const probe = zonedToUtc({ year, month, day });
    return isEnd ? endOfDayPlus(probe, 0) : probe;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(text)) throw errors.validation(`Data inválida em "${name}": use o formato AAAA-MM-DD ou ISO 8601.`, { field: name });
  return parsed;
}

function parseInteger(value, name, min, max) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.validation(`"${name}" deve ser um número inteiro entre ${min} e ${max}.`, { field: name, min, max });
  return n;
}

/**
 * Valida e normaliza os filtros de GET /calendar (M9-D801 §3.5). `windowDays` e `defaultPageSize` vêm dos parâmetros do
 * administrador. Sem from/to: janela padrão; só from: de from até o fim do dia (from + windowDays); só to: de hoje até to.
 */
function parseListQuery(query, { now, windowDays, defaultPageSize }) {
  const q = query || {};
  const text = (name) => (Array.isArray(q[name]) ? q[name][0] : q[name]);
  const base = defaultWindow(now, windowDays);
  const fromText = text('from');
  const toText = text('to');
  const from = fromText ? parseBoundary(String(fromText), 'from', false) : base.from;
  const to = toText ? parseBoundary(String(toText), 'to', true) : (fromText ? endOfDayPlus(from, windowDays) : base.to);
  if (from.getTime() > to.getTime()) throw errors.rangeInvalid();

  const sourceTypes = toList(q.sourceType).map((s) => s.toUpperCase());
  const unknown = sourceTypes.filter((s) => !SOURCE_TYPES.includes(s));
  if (unknown.length) throw errors.sourceInvalid({ invalid: unknown });

  const statuses = toList(q.status).map((s) => s.toUpperCase());
  if (statuses.some((s) => !STATUSES.includes(s))) throw errors.validation(`"status" deve ser um de: ${STATUSES.join(', ')}.`, { field: 'status' });

  const ownerUserId = text('ownerUserId') ? String(text('ownerUserId')) : null;
  if (ownerUserId && !UUID.test(ownerUserId)) throw errors.validation('"ownerUserId" deve ser um identificador válido.', { field: 'ownerUserId' });

  const page = parseInteger(text('page'), 'page', 1, 1000000) || 1;
  const pageSize = parseInteger(text('pageSize'), 'pageSize', 1, MAX_PAGE_SIZE) || Math.min(defaultPageSize, MAX_PAGE_SIZE);
  return { from, to, sourceTypes, statuses, ownerUserId, page, pageSize };
}

module.exports = { parseListQuery, toList, UUID };
