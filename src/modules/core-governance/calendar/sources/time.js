'use strict';

const { TIMEZONE } = require('../calendar.constants');

/** Diferença (ms) entre a hora de parede em `timeZone` e UTC no instante `utcMs` (negativa a oeste de Greenwich). */
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(utcMs / 1000) * 1000;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "AAAA-MM-DD" de um instante, visto em `timeZone` (a data que a pessoa enxerga no calendário). */
function dateKeyInZone(value, timeZone = TIMEZONE) {
  if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 23:59:59 do dia "AAAA-MM-DD" em `timeZone`, como instante (Date). */
function endOfDayInZone(dateKey, timeZone = TIMEZONE) {
  const [, y, m, d] = DATE_ONLY.exec(dateKey);
  const wall = Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59);
  return new Date(wall - zoneOffsetMs(wall, timeZone));
}

/** Prazo "só data" (DATEONLY, ou data de obra) vira 23:59:59 de Brasília; instante completo é mantido. `dateOnly` força o fim do dia. */
function dueFromDateValue(value, { dateOnly = true } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && DATE_ONLY.test(value)) return endOfDayInZone(value);
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return dateOnly ? endOfDayInZone(dateKeyInZone(instant)) : instant;
}

/** Soma meses a uma data "AAAA-MM-DD" (dia limitado ao último do mês de destino). */
function addMonthsToDateKey(dateKey, months) {
  const [, y, m, d] = DATE_ONLY.exec(dateKey);
  const target = new Date(Date.UTC(Number(y), Number(m) - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(Number(d), last);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

module.exports = { zoneOffsetMs, dateKeyInZone, endOfDayInZone, dueFromDateValue, addMonthsToDateKey };
