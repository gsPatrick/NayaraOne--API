'use strict';

/**
 * M9-D606 — resolvedor ÚNICO de período do BI, no calendário de America/Sao_Paulo (UTC-3 fixo, mesma premissa de utils/businessDate.js).
 * `resolvePeriod({ from, to, month, quarter, year, asOf, tz })` devolve { startInstant, endInstantExclusive, startDate, endDate,
 * asOfDate, label, kind }: intervalo [início, fim) com início = 00:00 de SP do dia inicial e fim = 00:00 de SP do dia SEGUINTE ao final.
 * Sem entrada, o período é o mês corrente de SP e a data-base é "hoje" de SP, ambos pelo relógio injetável (clock.now()).
 * Uma família de entrada por vez: from+to, month, quarter ou year. Ver period.calendar.js (comparações por data) e period.compare.js.
 */
const AppError = require('../../../utils/AppError');
const { BUSINESS_TIMEZONE, startOfBusinessDay } = require('../../../utils/businessDate');
const clock = require('./clock');
const dates = require('./period.dates');

const PERIOD_INVALID = 'Período inválido. Informe from/to em datas de calendário (AAAA-MM-DD), com início menor ou igual ao fim.';
const AS_OF_FUTURE = 'A data-base não pode estar no futuro.';
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;
const YEAR_RE = /^\d{4}$/;
const present = (v) => v !== undefined && v !== null && v !== '';

const invalidPeriod = () => AppError.badRequest(PERIOD_INVALID, 'ANALYTICS_PERIOD_INVALID');
const asOfFuture = () => AppError.badRequest(AS_OF_FUTURE, 'ANALYTICS_AS_OF_FUTURE');
const br = (date) => date.split('-').reverse().join('/');

/** 00:00 de São Paulo do dia de calendário `date` (+ `extraDays`), como instante UTC. */
function saoPauloMidnight(date, extraDays = 0) {
  const { y, m, d } = dates.parseDate(date);
  return startOfBusinessDay(new Date(Date.UTC(y, m - 1, d, 12)), extraDays);
}

/** Data-base: sem valor é "hoje" de SP; data inválida é 400 ANALYTICS_PERIOD_INVALID; depois de hoje é 400 ANALYTICS_AS_OF_FUTURE. */
function resolveAsOf(asOf) {
  const today = clock.businessToday();
  if (!present(asOf)) return today;
  const text = String(asOf);
  if (!dates.parseDate(text)) throw invalidPeriod();
  if (text > today) throw asOfFuture();
  return text;
}

function labelOf(kind, startDate, endDate) {
  const { y, m } = dates.parseDate(startDate);
  if (kind === 'MONTH') return `${MONTH_NAMES[m - 1]} de ${y}`;
  if (kind === 'QUARTER') return `${Math.ceil(m / 3)}º trimestre de ${y}`;
  if (kind === 'YEAR') return String(y);
  return `${br(startDate)} a ${br(endDate)}`;
}

/** Monta o período a partir de datas de calendário já validadas (usado pelo resolvedor e pela comparação). */
function fromDates(startDate, endDate, asOfDate, kind = 'RANGE') {
  if (!dates.parseDate(startDate) || !dates.parseDate(endDate) || startDate > endDate) throw invalidPeriod();
  return {
    startInstant: saoPauloMidnight(startDate),
    endInstantExclusive: saoPauloMidnight(endDate, 1),
    startDate, endDate, asOfDate, label: labelOf(kind, startDate, endDate), kind,
  };
}

function monthBounds(y, m, months) {
  const start = dates.key(y, m, 1);
  const last = dates.addMonthsFirstDay(start, months - 1);
  const { y: ly, m: lm } = dates.parseDate(last);
  return [start, dates.key(ly, lm, dates.lastDayOfMonth(ly, lm))];
}

function boundsOf(input, today) {
  const families = [present(input.from) || present(input.to), present(input.month), present(input.quarter), present(input.year)].filter(Boolean).length;
  if (families > 1) throw invalidPeriod();
  if (present(input.from) || present(input.to)) {
    if (!present(input.from) || !present(input.to)) throw invalidPeriod();
    return { kind: 'RANGE', bounds: [String(input.from), String(input.to)] };
  }
  if (present(input.month)) {
    const m = MONTH_RE.exec(String(input.month));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw invalidPeriod();
    return { kind: 'MONTH', bounds: monthBounds(Number(m[1]), Number(m[2]), 1) };
  }
  if (present(input.quarter)) {
    const q = QUARTER_RE.exec(String(input.quarter));
    if (!q) throw invalidPeriod();
    return { kind: 'QUARTER', bounds: monthBounds(Number(q[1]), (Number(q[2]) - 1) * 3 + 1, 3) };
  }
  if (present(input.year)) {
    if (!YEAR_RE.test(String(input.year))) throw invalidPeriod();
    return { kind: 'YEAR', bounds: monthBounds(Number(input.year), 1, 12) };
  }
  const { y, m } = dates.parseDate(today);
  return { kind: 'MONTH', bounds: monthBounds(y, m, 1) };
}

function resolvePeriod(input = {}) {
  const tz = input.tz === undefined ? BUSINESS_TIMEZONE : input.tz;
  if (tz !== BUSINESS_TIMEZONE) throw invalidPeriod(); // o BI só tem calendário de São Paulo
  const asOfDate = resolveAsOf(input.asOf);
  const { kind, bounds } = boundsOf(input, clock.businessToday());
  return fromDates(bounds[0], bounds[1], asOfDate, kind);
}

module.exports = { resolvePeriod, resolveAsOf, fromDates, saoPauloMidnight, PERIOD_INVALID, AS_OF_FUTURE };
