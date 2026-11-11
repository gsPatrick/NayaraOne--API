'use strict';

const { sequelize } = require('../../models');
const { KEYS, getConstructionSettings, listOf } = require('./construction.settings');
const { holidaySet } = require('../core-governance/calendar/businessDays');
const { getSetting } = require('../settings/settings.service');

/**
 * Regra "ausência de diário gera tarefa conforme regra" (Caderno Obras §6; verificação independente M6-108) lida dos
 * parâmetros da empresa (construction.settings.js): ligada/desligada, situações de obra que exigem diário, dias da
 * semana em que o diário é exigido, se os feriados do calendário da empresa (governanca.calendario.feriados; vazio =
 * feriados nacionais) contam, prioridade da tarefa e a janela/prioridade da tarefa de documentação do prestador.
 */
const MAX_LOOKBACK_DAYS = 31;

async function tenantOfTransaction(transaction) {
  const [[row]] = await sequelize.query(
    "SELECT NULLIF(current_setting('app.group_id', true), '') AS group_id, NULLIF(current_setting('app.company_id', true), '') AS company_id",
    { transaction }
  );
  return { groupId: row.group_id, companyId: row.company_id };
}

async function resolveMissingReportRule(tenant, transaction) {
  const t = tenant && tenant.companyId ? tenant : await tenantOfTransaction(transaction);
  const v = await getConstructionSettings(t, transaction);
  const considerHolidays = v[KEYS.missingReportHolidays] === true;
  const holidaysText = considerHolidays ? await getSetting('governanca.calendario.feriados', t, transaction, '') : '';
  return {
    tenant: t,
    enabled: v[KEYS.missingReportEnabled] !== false,
    statuses: listOf(v[KEYS.missingReportStatuses]),
    weekdays: new Set(listOf(v[KEYS.missingReportWeekdays]).map(Number)),
    considerHolidays,
    holidaysText,
    priority: v[KEYS.missingReportPriority],
    docsEnabled: v[KEYS.missingDocsEnabled] !== false,
    docsWindowDays: Number(v[KEYS.missingDocsWindowDays]),
    docsPriority: v[KEYS.missingDocsPriority],
  };
}

const iso = (date) => date.toISOString().slice(0, 10);

/** Dia anterior a `now` em que o diário é exigido pela regra (dia da semana configurado e, se ligado, não feriado). */
function previousRequiredDay(now, rule) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i += 1) {
    date.setUTCDate(date.getUTCDate() - 1);
    const day = iso(date);
    const holidays = rule.considerHolidays ? holidaySet(rule.holidaysText, [date.getUTCFullYear()]) : null;
    if (rule.weekdays.has(date.getUTCDay()) && !(holidays && holidays.has(day))) return day;
  }
  return null;
}

module.exports = { resolveMissingReportRule, previousRequiredDay };
