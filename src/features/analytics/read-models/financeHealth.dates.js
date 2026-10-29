'use strict';

/**
 * M9-D615 (3.3) — fronteiras de data do read model financeiro no calendário de São Paulo. Vencimento é DATA de calendário: a janela de N
 * dias vai de hoje até hoje+N-1, com limite superior exclusivo à meia-noite seguinte (M9-D621); vencido é antes de hoje (M9-D622).
 */
const { startOfBusinessDay } = require('../../../utils/businessDate');

const noonOf = (dateKey) => new Date(`${dateKey}T12:00:00-03:00`);

/** `asOf` = 'AAAA-MM-DD'; `windowDays` = janela da inadimplência. Todas as fronteiras são instantes (Date) em UTC. */
function financeBounds(asOf, windowDays) {
  const base = noonOf(asOf);
  const at = (days) => startOfBusinessDay(base, days);
  return {
    today: at(0),
    dayEnd: at(1),
    horizon7: at(7),
    horizon30: at(30),
    horizon60: at(60),
    windowStart: at(-(windowDays - 1)),
    monthStart: startOfBusinessDay(new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 1, 1, 15))),
    nextMonthStart: startOfBusinessDay(new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), 1, 15))),
  };
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

module.exports = { financeBounds, iso };
