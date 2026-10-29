'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const settings = require('../../features/core-governance/calendar/calendar.settings');
const { runConflictAlerts } = require('../../features/core-governance/calendar/alerts/conflict.alert');
const { runForEachCompany } = require('./calendarJobRunner');

/**
 * calendarConflictJob (M9-D802 §3.5) — detector de conflito de agenda, a cada `governanca.calendario.conflito_intervalo_min`
 * minutos (padrão 15). O processo confere a cada minuto e roda a empresa quando o intervalo dela venceu; a chave por par e por dia
 * evita realertar a cada execução. Lê só calendar_items. Desligar no processo: CALENDAR_CONFLICT_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 60 * 1000;
const lastRun = new Map();

async function runCalendarConflictJob(now = new Date(), { force = false } = {}) {
  return runForEachCompany('calendarConflictJob', async (tenant, transaction) => {
    const minutes = Number(await getSetting(settings.CONFLICT_INTERVAL_KEY, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[settings.CONFLICT_INTERVAL_KEY]));
    const last = lastRun.get(tenant.companyId);
    if (!force && last && now.getTime() - last < minutes * 60000) return null;
    const summary = await runConflictAlerts(tenant, transaction, now);
    lastRun.set(tenant.companyId, now.getTime());
    return summary;
  });
}

function startCalendarConflictJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runCalendarConflictJob().catch((err) => logger.error({ err: err.message }, 'calendarConflictJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runCalendarConflictJob, startCalendarConflictJob };
