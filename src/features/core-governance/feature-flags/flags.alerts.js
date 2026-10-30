'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { notify } = require('../calendar/alerts/alerts.log');
const { findCompanyUser, activeAdminIds } = require('../governance.users');

/** Quem recebe o alerta de uma chave: o responsável, se ativo; sem ele, os administradores ativos da empresa. */
async function recipientsOfOwner(tenant, ownerUserId, transaction) {
  const owner = await findCompanyUser(ownerUserId, tenant, transaction);
  return owner.active ? [ownerUserId] : activeAdminIds(tenant, transaction);
}

/** Reserva a chave do alerta (UNIQUE por empresa): true só para quem reservou primeiro, então o mesmo alerta nunca sai duas vezes. */
async function claimFlagAlert(tenant, { key, type, entryId, recipients }, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.flag_alert_log (group_id, company_id, alert_key, alert_type, entry_id, recipients)
     VALUES (:groupId, :companyId, :key, :type, :entryId, :recipients) ON CONFLICT (company_id, alert_key) DO NOTHING RETURNING id`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, key, type, entryId: entryId || null, recipients } }
  );
  return rows.length > 0;
}

/**
 * Alerta CRÍTICO de uma chave, uma vez por chave de deduplicação: reserva e depois notifica os destinatários (a reserva e as notificações saem na mesma transação).
 * Devolve quantas pessoas foram avisadas (0 quando o alerta já tinha saído).
 */
async function sendCriticalAlert(tenant, { alertKey, type, entry, title, body }, transaction) {
  const recipients = await recipientsOfOwner(tenant, entry.owner_user_id, transaction);
  if (!await claimFlagAlert(tenant, { key: alertKey, type, entryId: entry.id, recipients: recipients.length }, transaction)) return 0;
  await notify(tenant, recipients, { title: `CRÍTICO: ${title}`, body }, transaction);
  return recipients.length;
}

module.exports = { sendCriticalAlert, claimFlagAlert, recipientsOfOwner };
