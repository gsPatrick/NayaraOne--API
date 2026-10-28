'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const settings = require('../../modules/core-governance/calendar/calendar.settings');
const { moduleSettingKey } = require('../../modules/core-governance/governance.settings');
const { runBackfill } = require('../../modules/core-governance/calendar/sources/backfill.service');
const { dateKeyInZone, zoneOffsetMs } = require('../../modules/core-governance/calendar/sources/time');

/**
 * calendarBackfillJob (M9-D803 §3.4 e §3.2.1) — varredura diária do Calendário nas fontes de obras e garantias: traz os
 * registros abertos que existiam antes da ativação, fecha a garantia de obra vencida e cancela o item cuja origem não está
 * mais aberta. Roda uma vez por dia por empresa, na hora configurada (`governanca.calendario.varredura_hora`, padrão 06:00
 * America/Sao_Paulo); a checagem acontece a cada 10 minutos. Idempotente (reexecução não duplica).
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastRunDay = new Map();

/** Hora cheia (0 a 23) de `now` em Brasília. */
function hourInSaoPaulo(now) {
  return Math.floor((((now.getTime() + zoneOffsetMs(now.getTime(), 'America/Sao_Paulo')) % 86400000) + 86400000) % 86400000 / 3600000);
}

async function runCompany(group, company, now, force) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', {
      replacements: { groupId: group.id, companyId: company.id }, transaction,
    });
    const tenant = { groupId: group.id, companyId: company.id };
    if ((await getSetting(moduleSettingKey('calendar'), tenant, transaction, true)) === false) return null;
    const hour = Number(await getSetting(settings.BACKFILL_HOUR_KEY, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[settings.BACKFILL_HOUR_KEY]));
    const day = dateKeyInZone(now);
    if (!force && (hourInSaoPaulo(now) !== hour || lastRunDay.get(company.id) === day)) return null;
    const summary = await runBackfill(tenant, transaction, now);
    lastRunDay.set(company.id, day);
    return summary;
  });
}

async function runCalendarBackfillJob(now = new Date(), { force = false } = {}) {
  const total = { companies: 0, ran: 0, upserted: 0, warrantyClosed: 0, cancelled: 0, errors: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      try {
        const summary = await runCompany(group, company, now, force);
        if (summary) {
          total.ran += 1; total.upserted += summary.upserted; total.warrantyClosed += summary.warrantyClosed; total.cancelled += summary.cancelled;
        }
      } catch (err) {
        total.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, 'calendarBackfillJob.company.failed');
      }
    }
  }
  if (total.ran || total.errors) logger.info(total, 'calendarBackfillJob.run');
  return total;
}

function startCalendarBackfillJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runCalendarBackfillJob().catch((err) => logger.error({ err: err.message }, 'calendarBackfillJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runCalendarBackfillJob, startCalendarBackfillJob, hourInSaoPaulo };
