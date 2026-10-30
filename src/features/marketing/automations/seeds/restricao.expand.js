'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getMarketingParam } = require('../cadence/marketingParam.service');
const { QUIET_HOURS_KEY } = require('../cadence/cadence.defaults');
const { localDateOf, civilDaysBetween } = require('../cadence/zonedTime');
const { readRestricaoParams } = require('./restricao.settings');

const rows = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/** A série desta pendência já expirou (existe run BLOCKED EXPIRED dela neste fluxo)? A run EXPIRED impede nova expiração. */
async function alreadyExpired(flowId, pendingRef, transaction) {
  const found = await rows(
    `SELECT 1 AS ok FROM marketing.automation_runs r JOIN marketing.automation_versions v ON v.id = r.automation_version_id AND v.company_id = r.company_id
      WHERE v.flow_id = :flowId AND r.trigger_event_id LIKE :prefix AND r.blocked_reason = 'EXPIRED' LIMIT 1`,
    { flowId, prefix: `sched:${flowId}:${pendingRef}:%` }, transaction
  );
  return found.length > 0;
}

/**
 * Expansão do tick diário (registerScheduleExpander): cada pendência ABERTA é um sujeito, com eventId sintético `sched:{fluxo}:{pendência}:{data}` (uma run por pendência por dia).
 * `dias` = data do tick - data da abertura, em dias corridos no fuso da empresa. Fase REMINDER: dias > 0, dias < expiração e dias múltiplo do intervalo. Fase EXPIRATION:
 * dias >= expiração e ainda sem run EXPIRED. Nos demais dias a run nem é criada. As pendências são lidas FOR SHARE na transação do tick: resolver a pendência ao mesmo tempo
 * espera o tick e vale a partir do próximo.
 */
async function expandPendings(cand, { tenant, transaction, now }) {
  const phase = cand.version.triggerConfig.phase;
  const { intervalDays, expirationDays } = await readRestricaoParams(tenant, transaction);
  const { timeZone } = await getMarketingParam(QUIET_HOURS_KEY, tenant, transaction);
  const today = localDateOf(now, timeZone);
  const open = await rows("SELECT pending_ref, person_id, responsible_user_id, opened_at FROM marketing.reminder_pendings WHERE company_id = :c AND status = 'OPEN' ORDER BY opened_at, id FOR SHARE",
    { c: tenant.companyId }, transaction);
  const items = [];
  for (const row of open) {
    const days = civilDaysBetween(localDateOf(new Date(row.opened_at), timeZone), today);
    const due = phase === 'EXPIRATION'
      ? days >= expirationDays && !(await alreadyExpired(cand.flow.id, row.pending_ref, transaction))
      : days > 0 && days < expirationDays && days % intervalDays === 0;
    if (due) items.push({ eventId: `sched:${cand.flow.id}:${row.pending_ref}:${today}`, subject: { type: 'PERSON', id: row.person_id }, payload: { pendingId: row.pending_ref, days, responsibleUserId: row.responsible_user_id } });
  }
  return items;
}

module.exports = { expandPendings, EXPAND_NAME: 'PENDING_REMINDERS' };
