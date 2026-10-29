'use strict';

const { dateKeyInZone, endOfDayInZone } = require('../../calendar/sources/time');

/** Dias de calendário (America/Sao_Paulo) entre `now` e `sunsetAt`; 0 quando o desligamento é hoje ou já passou. */
function daysToSunset(sunsetAt, now = new Date()) {
  const day = (value) => { const [y, m, d] = dateKeyInZone(value).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  return Math.max(0, day(sunsetAt) - day(now));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lê data de entrada: "AAAA-MM-DD" vale o início do dia (anúncio) ou o fim do dia (desligamento) em Brasília; data e hora ISO vale o instante. Inválida: null.
 * (Brasília não tem horário de verão desde 2019; o início do dia é o fim do dia menos 23:59:59.)
 */
function parseMoment(value, { endOfDay = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const end = endOfDayInZone(text);
    if (Number.isNaN(end.getTime()) || dateKeyInZone(end) !== text) return null;
    return endOfDay ? end : new Date(end.getTime() - 86399000);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

module.exports = { daysToSunset, parseMoment };
