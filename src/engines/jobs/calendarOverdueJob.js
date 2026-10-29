'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const settings = require('../../features/core-governance/calendar/calendar.settings');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runOverdueAlerts } = require('../../features/core-governance/calendar/alerts/overdue.alert');
const { runForEachCompany } = require('./calendarJobRunner');
const { hourInSaoPaulo } = require('./calendarBackfillJob');

/**
 * calendarOverdueJob (M9-D802 §3.5) — varredura diária dos itens vencidos, na hora configurada
 * (`governanca.calendario.alerta_vencido_hora`, padrão 06:00 America/Sao_Paulo). Checa a cada 10 minutos e roda uma vez por dia por
 * empresa; a chave diária do alerta garante um aviso por item e por dia mesmo se o job rodar de novo. Lê só calendar_items.
 * Desligar no processo: CALENDAR_OVERDUE_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastRunDay = new Map();

async function runCalendarOverdueJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany('calendarOverdueJob', async (tenant, transaction) => {
    const hour = Number(await getSetting(settings.OVERDUE_HOUR_KEY, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[settings.OVERDUE_HOUR_KEY]));
    const day = dateKeyInZone(now);
    if (!force && (hourInSaoPaulo(now) !== hour || lastRunDay.get(tenant.companyId) === day)) return null;
    const summary = await runOverdueAlerts(tenant, transaction, now);
    lastRunDay.set(tenant.companyId, day);
    return summary;
  });
}

function startCalendarOverdueJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runCalendarOverdueJob().catch((err) => logger.error({ err: err.message }, 'calendarOverdueJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runCalendarOverdueJob, startCalendarOverdueJob };
