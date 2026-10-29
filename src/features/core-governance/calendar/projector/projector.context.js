'use strict';

const { getSetting } = require('../../../settings/settings.service');
const settings = require('../calendar.settings');
const { moduleSettingKey } = require('../../governance.settings');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[key]);

/** Parâmetros que o mapeamento das fontes usa (severidade, papel por fonte e duração padrão), lidos a cada evento. */
async function readProjectorContext(tenant, transaction) {
  return {
    companyId: tenant.companyId,
    severityMap: settings.parseSeverityMap(await read(settings.SEVERITY_KEY, tenant, transaction)),
    teamMap: settings.parseTeamMap(await read(settings.TEAM_KEY, tenant, transaction)),
    durationMin: Number(await read(settings.DURATION_KEY, tenant, transaction)) || settings.CALENDAR_SETTING_DEFAULTS[settings.DURATION_KEY],
  };
}

/** O administrador desligou o módulo Calendário para a empresa? (padrão ligado) */
async function isCalendarEnabled(tenant, transaction) {
  return (await getSetting(moduleSettingKey('calendar'), tenant, transaction, true)) !== false;
}

module.exports = { readProjectorContext, isCalendarEnabled };
