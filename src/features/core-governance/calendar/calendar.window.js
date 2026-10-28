'use strict';

const { TIMEZONE } = require('./calendar.constants');

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

/** Data/hora de parede de um instante no fuso. */
function wallClock(date, timeZone = TIMEZONE) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(date)) parts[type] = Number(value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Instante UTC que corresponde à hora de parede no fuso (dia pode estourar o mês: o JS normaliza). */
function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = TIMEZONE) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = guess;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(result), timeZone);
    result += guess - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  }
  return new Date(result);
}

/** Início (00:00:00) do dia do instante, no fuso. */
function startOfDay(date, timeZone = TIMEZONE) {
  const w = wallClock(date, timeZone);
  return zonedToUtc({ year: w.year, month: w.month, day: w.day }, timeZone);
}

/** Fim (23:59:59) do dia que fica `days` dias depois do dia do instante, no fuso. */
function endOfDayPlus(date, days, timeZone = TIMEZONE) {
  const w = wallClock(date, timeZone);
  return zonedToUtc({ year: w.year, month: w.month, day: w.day + days, hour: 23, minute: 59, second: 59 }, timeZone);
}

/** Janela padrão do livro: hoje 00:00 até (hoje + `days`) 23:59:59, em America/Sao_Paulo. `days` vem do parâmetro do administrador. */
function defaultWindow(now, days) {
  return { from: startOfDay(now), to: endOfDayPlus(now, days) };
}

module.exports = { wallClock, zonedToUtc, startOfDay, endOfDayPlus, defaultWindow };
