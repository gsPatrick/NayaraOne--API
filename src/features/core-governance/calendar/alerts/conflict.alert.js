'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const settings = require('../calendar.settings');
const { dateKeyInZone } = require('../sources/time');
const { claimAlert, notify } = require('./alerts.log');
const { ALERT_TYPE } = require('./alerts.constants');

// Janela de cada item: [due_at, fim). O fim é end_at ou, sem ele, o início mais a duração padrão. Sobreposição estrita: 11:00-11:00 não conflita.
const PAIRS_SQL = `
WITH w AS (
  SELECT id, title, owner_user_id, due_at AS s, COALESCE(end_at, due_at + make_interval(mins => :durationMin)) AS e
    FROM governance.calendar_items
   WHERE company_id = :companyId AND status = 'OPEN' AND owner_user_id IS NOT NULL AND source_type = ANY(ARRAY[:sources]::varchar[])
)
SELECT a.id AS a_id, a.title AS a_title, b.id AS b_id, b.title AS b_title, a.owner_user_id,
       floor(extract(epoch FROM (least(a.e, b.e) - greatest(a.s, b.s))) / 60)::int AS overlap_min
  FROM w a JOIN w b ON a.owner_user_id = b.owner_user_id AND a.id < b.id AND a.s < b.e AND b.s < a.e
 WHERE greatest(a.e, b.e) > :now
 ORDER BY a.id, b.id`;

/**
 * Alerta de CONFLITO de agenda (M9-D802 §3.5): dois itens OPEN das fontes configuradas, do mesmo responsável, com janelas que se
 * sobrepõem. Lê só `calendar_items`; um alerta por par e por dia (`calendar.conflict:<menorId>:<maiorId>:<AAAA-MM-DD>`).
 */
async function runConflictAlerts(tenant, transaction, now = new Date()) {
  const read = (key) => getSetting(key, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[key]);
  const durationMin = Number(await read(settings.DURATION_KEY)) || settings.CALENDAR_SETTING_DEFAULTS[settings.DURATION_KEY];
  const sources = settings.parseSourceList(await read(settings.CONFLICT_SOURCES_KEY), settings.CALENDAR_SETTING_DEFAULTS[settings.CONFLICT_SOURCES_KEY]);
  const pairs = await sequelize.query(PAIRS_SQL, { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, durationMin, sources, now } });
  const day = dateKeyInZone(now);
  const summary = { pairs: pairs.length, alerted: 0, skipped: 0 };
  for (const pair of pairs) {
    const claimed = await claimAlert(tenant, { key: `calendar.conflict:${pair.a_id}:${pair.b_id}:${day}`, type: ALERT_TYPE.CONFLICT, itemId: pair.a_id, recipients: 1 }, transaction);
    if (!claimed) { summary.skipped += 1; continue; }
    await notify(tenant, [pair.owner_user_id], {
      title: 'Conflito de agenda',
      body: `${ALERT_TYPE.CONFLICT}: "${pair.a_title}" e "${pair.b_title}" se sobrepõem em ${pair.overlap_min} minuto(s).`,
    }, transaction);
    summary.alerted += 1;
  }
  return summary;
}

module.exports = { runConflictAlerts };
