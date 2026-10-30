'use strict';

const MINUTE_MS = 60000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Deslocamento (ms) do fuso em relação ao UTC no instante dado. */
function zoneOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(instant).map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Data civil (AAAA-MM-DD) do instante no fuso. */
function localDateOf(instant, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Soma dias corridos a uma data civil (AAAA-MM-DD). */
function addCivilDays(dateOnly, days) {
  return new Date(Date.parse(`${dateOnly}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Diferença em dias corridos entre duas datas civis (b - a). */
const civilDaysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);

/** Instante UTC em que o relógio do fuso marca `minutes` (minutos desde a meia-noite) na data civil. */
function zonedToUtc(dateOnly, minutes, timeZone) {
  const guess = new Date(Date.parse(`${dateOnly}T00:00:00.000Z`) + minutes * MINUTE_MS);
  const first = guess.getTime() - zoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - zoneOffsetMs(new Date(first), timeZone));
}

module.exports = { zoneOffsetMs, localDateOf, addCivilDays, civilDaysBetween, zonedToUtc };
