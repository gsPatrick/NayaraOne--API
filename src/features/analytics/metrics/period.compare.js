'use strict';

/**
 * M9-D606 (3.2 regras 6 e 7) — comparação de períodos. Período anterior = mesma duração imediatamente antes ([início − duração, início));
 * quando o período é de meses inteiros (mês, trimestre, ano, ou um intervalo que começa no dia 1 e termina no último dia de um mês)
 * o anterior são os mesmos meses de calendário (março contra fevereiro, não 31 dias antes). Competência (AAAA-MM) é usada como está.
 */
const dates = require('./period.dates');
const { fromDates } = require('./period');

function wholeMonths(period) {
  const start = dates.parseDate(period.startDate);
  const end = dates.parseDate(period.endDate);
  if (start.d !== 1 || end.d !== dates.lastDayOfMonth(end.y, end.m)) return 0;
  return (end.y - start.y) * 12 + (end.m - start.m) + 1;
}

/** Período anterior ao dado. A data-base dele é o seu último dia (sempre no passado). */
function previousPeriod(period) {
  const months = wholeMonths(period);
  if (months > 0) {
    const start = dates.addMonthsFirstDay(period.startDate, -months);
    return fromDates(start, dates.addDays(period.startDate, -1), dates.addDays(period.startDate, -1), period.kind);
  }
  const length = Math.round((period.endInstantExclusive.getTime() - period.startInstant.getTime()) / 86400000);
  return fromDates(dates.addDays(period.startDate, -length), dates.addDays(period.startDate, -1), dates.addDays(period.startDate, -1), period.kind);
}

/** Meses de competência (AAAA-MM) que o período toca, em ordem. */
function competenceMonthsOf(period) {
  const months = [];
  for (let m = dates.monthKey(period.startDate); m <= dates.monthKey(period.endDate); m = dates.monthKey(dates.addMonthsFirstDay(`${m}-01`, 1))) months.push(m);
  return months;
}

module.exports = { previousPeriod, competenceMonthsOf };
