'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { dateKeyInZone } = require('../sources/time');
const { recipientsOf, claimAlert, notify } = require('./alerts.log');
const { ALERT_TYPE } = require('./alerts.constants');

/**
 * Alerta de item VENCIDO (M9-D802 §3.5): lê SÓ `governance.calendar_items` (nunca as tabelas de origem, decisão K9) e avisa o
 * responsável, ou os usuários ativos do papel de `owner_team`, uma vez por item e por dia (`calendar.overdue:<item>:<AAAA-MM-DD>`).
 */
async function runOverdueAlerts(tenant, transaction, now = new Date()) {
  const items = await sequelize.query(
    "SELECT * FROM governance.calendar_items WHERE company_id = :companyId AND status = 'OPEN' AND due_at < :now ORDER BY due_at, id",
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, now } }
  );
  const day = dateKeyInZone(now);
  const summary = { checked: items.length, alerted: 0, skipped: 0 };
  for (const item of items) {
    const recipients = await recipientsOf(item, tenant, transaction);
    if (!recipients.length) { summary.skipped += 1; continue; }
    const claimed = await claimAlert(tenant, { key: `calendar.overdue:${item.id}:${day}`, type: ALERT_TYPE.OVERDUE, itemId: item.id, recipients: recipients.length }, transaction);
    if (!claimed) { summary.skipped += 1; continue; }
    await notify(tenant, recipients, {
      title: 'Item vencido no calendário',
      body: `"${item.title}" venceu em ${dateKeyInZone(item.due_at)} e continua aberto na origem. Abra ${item.deep_link} para concluir.`,
    }, transaction);
    summary.alerted += 1;
  }
  return summary;
}

module.exports = { runOverdueAlerts };
