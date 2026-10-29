'use strict';

/**
 * M9-D607 (3.3) — decide se o job agendado deve rodar agora para uma empresa, segundo `analytics.refresh.schedule`
 * ("a cada N min e às HH:MM Fuso"): roda a cada N minutos E uma vez por dia a partir de HH:MM do fuso (virada do dia de São Paulo),
 * porque a passagem do tempo muda vencimentos e atrasos sem nenhum evento. O estado (última passada e último dia da virada) fica
 * em memória do processo: reinício do processo só repete uma passada, que é idempotente.
 */
function localParts(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, minutesOfDay: Number.parseInt(parts.hour, 10) * 60 + Number.parseInt(parts.minute, 10) };
}

/** { due, reason: 'FIRST' | 'DAILY' | 'INTERVAL' | null, local }. `state` = { lastRunAt: Date|null, lastDailyKey: string|null }. */
function scheduleDue(now, schedule, state = {}) {
  const local = localParts(now, schedule.timezone);
  const dailyReached = local.minutesOfDay >= schedule.minutesOfDay;
  if (!state.lastRunAt) return { due: true, reason: 'FIRST', local };
  if (dailyReached && state.lastDailyKey !== local.dateKey) return { due: true, reason: 'DAILY', local };
  if (now.getTime() - state.lastRunAt.getTime() >= schedule.everyMinutes * 60 * 1000) return { due: true, reason: 'INTERVAL', local };
  return { due: false, reason: null, local };
}

/** Estado depois de uma passada feita em `now`. */
function afterRun(now, schedule, local) {
  return { lastRunAt: now, lastDailyKey: local.minutesOfDay >= schedule.minutesOfDay ? local.dateKey : null };
}

module.exports = { scheduleDue, afterRun, localParts };
