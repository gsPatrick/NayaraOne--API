'use strict';

const crypto = require('node:crypto');
const { findScheduled } = require('./runner.load');
const { processEvent, setTenant } = require('./runner.service');

const MINUTE = 60000;

function fieldMatches(field, value, min, max) {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    let [from, to] = [min, max];
    if (range !== '*') [from, to] = range.includes('-') ? range.split('-').map(Number) : [Number(range), stepText ? max : Number(range)];
    return value >= from && value <= to && (value - from) % step === 0;
  });
}

/** Cron de 5 campos (minuto hora dia mês dia-da-semana), avaliado no fuso do gatilho. Domingo é 0 ou 7. */
function cronMatches(cron, date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  return fieldMatches(minute, Number(parts.minute), 0, 59) && fieldMatches(hour, Number(parts.hour), 0, 23) && fieldMatches(dom, Number(parts.day), 1, 31)
    && fieldMatches(month, Number(parts.month), 1, 12) && (fieldMatches(dow, weekday, 0, 6) || (weekday === 0 && fieldMatches(dow, 7, 0, 7)));
}

/**
 * Tick de agenda (automationRunnerJob, a cada minuto): para cada fluxo ACTIVE com gatilho SCHEDULE cuja expressão cron casa com o minuto atual, gera o evento sintético
 * `sched:{fluxo}:{janela ISO}` e o processa pelo mesmo runner. A janela é o minuto cheio em UTC; o inbox por eventId e a chave da run impedem a segunda execução da janela.
 */
async function runScheduleTick(tenant, transaction, options = {}) {
  await setTenant(tenant, transaction);
  const now = options.now || new Date();
  const window = new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);
  let created = 0;
  for (const cand of await findScheduled(transaction)) {
    const cfg = cand.version.triggerConfig;
    if (!cronMatches(cfg.cron, window, cfg.timeZone)) continue;
    const out = await processEvent({ eventId: `sched:${cand.flow.id}:${window.toISOString()}`, eventType: 'schedule', subject: null, tenant, payload: {}, correlationId: crypto.randomUUID() }, transaction, { ...options, now, candidates: [cand] });
    created += out.runs.filter((r) => !r.replay).length;
  }
  return { created, window: window.toISOString() };
}

module.exports = { runScheduleTick, cronMatches };
