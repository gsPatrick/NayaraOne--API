'use strict';

const { CADENCE_LIMITS } = require('./cadence.defaults');

/** Lista de dias: aceita "3,30,90" ou "[3,30,90]". Devolve null se não for uma lista crescente de inteiros dentro da faixa. */
function parseDaysList(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const parts = body.split(',').map((item) => item.trim());
  if (parts.length === 0 || parts.length > CADENCE_LIMITS.maxListItems) return null;
  const days = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < CADENCE_LIMITS.minDay || n > CADENCE_LIMITS.maxDay) return null;
    if (days.length > 0 && n <= days[days.length - 1]) return null;
    days.push(n);
  }
  return days;
}

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch (err) {
    return false;
  }
}

/** "21:00 a 08:00 America/Sao_Paulo" -> { startMinutes, endMinutes, timeZone }. Início e fim diferentes; hora 00-23, minuto 00-59. */
function parseQuietHours(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d{2}):(\d{2})\s+a\s+(\d{2}):(\d{2})\s+(\S+)\s*$/.exec(text);
  if (!m) return null;
  const [sh, sm, eh, em] = [m[1], m[2], m[3], m[4]].map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  if (startMinutes === endMinutes || !validTimeZone(m[5])) return null;
  return { startMinutes, endMinutes, timeZone: m[5] };
}

/** "3 mensagens por 7 dias [por pessoa, canal e finalidade]" -> { messages, days }. */
function parseFrequencyCap(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d+)\s+mensagens?\s+por\s+(\d+)\s+dias?(?:\s+por\s+pessoa,\s*canal\s+e\s+finalidade)?\s*$/.exec(text);
  if (!m) return null;
  const messages = Number(m[1]);
  const days = Number(m[2]);
  if (messages < 1 || messages > CADENCE_LIMITS.maxCapMessages || days < 1 || days > CADENCE_LIMITS.maxCapDays) return null;
  return { messages, days };
}

/** "10:00" -> { minutes } (minutos desde a meia-noite). Hora 00-23, minuto 00-59. */
function parseTimeOfDay(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d{2}):(\d{2})\s*$/.exec(text);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { minutes: Number(m[1]) * 60 + Number(m[2]) };
}

module.exports = { parseTimeOfDay, parseDaysList, parseQuietHours, parseFrequencyCap, validTimeZone };
