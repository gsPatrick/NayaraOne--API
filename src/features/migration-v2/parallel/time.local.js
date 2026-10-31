'use strict';

const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/** Deslocamento (ms) do fuso em relação ao UTC no instante dado. */
function zoneOffsetMs(instantMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Instante de um texto de data/hora da janela. Com deslocamento (`Z`, `-03:00`) vale o instante; sem deslocamento é hora de parede do fuso informado (M9-D903 §3.1: a janela
 * é definida em America/Sao_Paulo). Devolve null se o texto não é uma data válida.
 */
function parseWindowInstant(value, timeZone) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;
  if (OFFSET.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const m = LOCAL.exec(raw);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  if (Number.isNaN(wall) || new Date(wall).getUTCMonth() !== Number(m[2]) - 1) return null;
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

module.exports = { parseWindowInstant, zoneOffsetMs };
