'use strict';

/**
 * M9-D609 (3.3) — quais data-base o snapshot diário precisa gravar numa passada. Puro (sem banco).
 * A data-base normal é D-1 (ontem em São Paulo). Catch-up: o job ficou sem rodar e há dias entre a última data COMPLETA e D-1; também voltam
 * os dias PARTIAL (alguma métrica falhou). Sem nenhuma passada anterior só o D-1 entra (não se inventa histórico). Passada com algum dia anterior
 * a D-1 é catch-up: TODOS os snapshots dela saem com captured_late = true (o job não rodou no ciclo certo).
 */
const { addDays } = require('./period.dates');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

/**
 * runs: [{ as_of_date: 'AAAA-MM-DD', status }] já gravadas. Devolve { days: [ascendente], late: boolean }.
 */
function pendingDays({ today, runs, maxBackfillDays }) {
  const yesterday = addDays(today, -1);
  const floor = addDays(yesterday, -(maxBackfillDays - 1));
  const completed = runs.filter((r) => r.status === 'COMPLETED').map((r) => r.as_of_date);
  const done = new Set(completed);
  const partial = runs.filter((r) => r.status === 'PARTIAL' && r.as_of_date >= floor && r.as_of_date <= yesterday).map((r) => r.as_of_date);
  const last = completed.length ? completed.reduce((a, b) => (a > b ? a : b)) : null;
  const days = new Set(partial);
  days.add(yesterday);
  if (last) for (let d = addDays(last, 1) < floor ? floor : addDays(last, 1); d <= yesterday; d = addDays(d, 1)) days.add(d);
  const list = [...days].filter((d) => !done.has(d)).sort();
  return { days: list, late: list.some((d) => d < yesterday) };
}

/** Minutos desde 00:00 em São Paulo no instante dado (a agenda diária é do fuso do negócio). */
function minutesOfDaySaoPaulo(instant) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIMEZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(instant)).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return Number.parseInt(parts.hour, 10) * 60 + Number.parseInt(parts.minute, 10);
}

module.exports = { pendingDays, minutesOfDaySaoPaulo };
