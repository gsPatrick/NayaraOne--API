'use strict';

const { TIME_ZONE } = require('./bcp.constants');

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Diferença (ms) entre o relógio de São Paulo e o UTC no instante dado. */
function zoneOffsetMs(instant) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * Interpreta a data/hora da ocorrência do papel (M9-D831 §3.3): texto com fuso (Z ou ±hh:mm) vale como está; data (AAAA-MM-DD) ou data e hora SEM fuso são horário de
 * Brasília (America/Sao_Paulo). Devolve Date, ou null se for inválida (dia inexistente, formato desconhecido).
 */
function parseOccurredAt(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (WITH_ZONE.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const m = LOCAL.exec(text);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((n) => (n === undefined ? undefined : Number(n)));
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  const first = guess - zoneOffsetMs(guess);
  return new Date(guess - zoneOffsetMs(first));
}

module.exports = { parseOccurredAt };
