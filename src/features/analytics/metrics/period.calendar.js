'use strict';

/**
 * M9-D606 (3.2 regras 2, 3 e 8) — decisões por data de calendário de São Paulo, sempre sobre o resultado de `resolvePeriod`:
 *  - liquidação e criação (instantes) viram a data de SP antes de decidir o mês/dia (`businessDateOf`, `instantInPeriod`);
 *  - vencimento (gravado ao meio-dia) compara pela DATA, não pelo instante (`isOverdueOn`): vence hoje = não vencida;
 *  - dias corridos são a regra do BI; dias úteis só para analytics.repasse.dias_alerta (M9-D623), contados com o helper do jurídico.
 */
const { businessDateKey } = require('../../../utils/businessDate');
const { previousBusinessDay, toDateOnlyString } = require('../../../engines/jobs/businessDays.helper');
const { daysBetween } = require('./formulas/_dates');
const dates = require('./period.dates');

const businessDateOf = (instant) => businessDateKey(instant);
const dueDateOf = (dueAt) => businessDateKey(dueAt);

/** O instante cai em [início, fim) do período? */
function instantInPeriod(instant, period) {
  const t = new Date(instant).getTime();
  return t >= period.startInstant.getTime() && t < period.endInstantExclusive.getTime();
}

/** A data de calendário (AAAA-MM-DD) está entre o dia inicial e o final do período? */
function dateInPeriod(date, period) {
  return date >= period.startDate && date <= period.endDate;
}

/** Vencida na data-base? Só a partir do dia seguinte ao vencimento (a parcela que vence hoje não está vencida). */
function isOverdueOn(dueAt, asOfDate) {
  if (!dueAt) return false;
  return businessDateKey(dueAt) < asOfDate;
}

/** Dias corridos de `from` até `to` (negativo se `to` é anterior). */
const calendarDaysBetween = (from, to) => daysBetween(from, to);

/** Dias úteis (segunda a sexta, critério do helper do jurídico) depois de `from` até `to` inclusive; negativo se `to` é anterior. */
function businessDaysBetween(from, to) {
  if (daysBetween(from, to) < 0) return -businessDaysBetween(to, from);
  let count = 0;
  let cursor = new Date(`${dates.addDays(to, 1)}T00:00:00Z`);
  for (;;) {
    cursor = previousBusinessDay(cursor);
    if (toDateOnlyString(cursor) <= from) return count;
    count += 1;
  }
}

module.exports = { businessDateOf, dueDateOf, instantInPeriod, dateInPeriod, isOverdueOn, calendarDaysBetween, businessDaysBetween };
