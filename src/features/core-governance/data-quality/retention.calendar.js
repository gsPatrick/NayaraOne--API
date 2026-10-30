'use strict';

const { TIME_ZONE } = require('./retention.constants');

const pad = (n) => String(n).padStart(2, '0');
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Soma meses de calendário a uma data AAAA-MM-DD: mesmo dia, e dia que não existe no mês de destino vira o último dia dele (31/08 + 6 meses = 28/02). Mesma regra do Postgres (`date + interval`). */
function addCalendarMonths(isoDate, months) {
  const match = DATE.exec(String(isoDate));
  if (!match || !Number.isInteger(months) || months < 0) throw new Error('addCalendarMonths exige data AAAA-MM-DD e meses inteiros não negativos.');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const index = year * 12 + (month - 1) + months;
  const [targetYear, targetMonth] = [Math.floor(index / 12), (index % 12) + 1];
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

/** A data de hoje no fuso de Brasília (AAAA-MM-DD). */
function todayInZone(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Hora e minuto de Brasília. */
function clockInZone(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

module.exports = { addCalendarMonths, todayInZone, clockInZone };
