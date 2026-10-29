'use strict';

/**
 * M9-D693 (3.1) — período e agenda do briefing, no calendário de São Paulo. Diário: cobre D-1. Semanal: cobre a semana anterior (segunda a
 * domingo). O período anterior (base da variação, M9-D694) vem do resolvedor único do BI (M9-D606): mesma duração imediatamente antes.
 * Passou do horário configurado, o briefing do período está devido até o fim do dia (diário) ou da semana (semanal): se o servidor ficou
 * parado na hora marcada, o job recupera na volta.
 */
const { resolvePeriod, previousPeriod, clock } = require('../metrics');

const DAY_MS = 86400000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Minutos desde a meia-noite de São Paulo no instante dado. */
function minutesOfDay(instant) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

const mondayOf = (date) => addDays(date, -((weekdayOf(date) + 6) % 7));

/** { startDate, endDate } do período que o briefing do tipo cobre, visto de `now`. */
function coveredPeriod(briefType, now) {
  const today = clock.businessToday(now);
  if (briefType === 'WEEKLY') {
    const monday = mondayOf(today);
    return { startDate: addDays(monday, -7), endDate: addDays(monday, -1) };
  }
  const yesterday = addDays(today, -1);
  return { startDate: yesterday, endDate: yesterday };
}

/** Períodos resolvidos pelo BI: o coberto e o anterior de mesma duração. Exige o relógio do BI em `now` ou depois. */
function resolveBriefPeriods(briefType, now) {
  const { startDate, endDate } = coveredPeriod(briefType, now);
  const current = resolvePeriod({ from: startDate, to: endDate, asOf: endDate });
  return { current, previous: previousPeriod(current) };
}

/** O briefing do tipo já está devido em `now`? Diário: a partir da hora do dia. Semanal: a partir do dia e da hora da semana corrente. */
function isDue(briefType, now, params) {
  const today = clock.businessToday(now);
  const minutes = minutesOfDay(now);
  if (briefType === 'DAILY') return minutes >= params.daily.minutes;
  const scheduledDay = addDays(mondayOf(today), (params.weekly.weekday + 6) % 7);
  return today > scheduledDay || (today === scheduledDay && minutes >= params.weekly.minutes);
}

module.exports = { addDays, weekdayOf, minutesOfDay, mondayOf, coveredPeriod, resolveBriefPeriods, isDue };
