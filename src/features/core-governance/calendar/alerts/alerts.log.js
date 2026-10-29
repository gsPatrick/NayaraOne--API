'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Notification } = require('../../../../models');
const { activeUserIdsWithRole, findCompanyUser } = require('../../governance.users');
const { CHANNEL_IN_APP } = require('./alerts.constants');

/** Destinatários do alerta: o responsável (se ativo) ou, sem usuário, todos os ativos do papel gravado em `owner_team`. */
async function recipientsOf(item, tenant, transaction) {
  if (item.owner_user_id) {
    const user = await findCompanyUser(item.owner_user_id, tenant, transaction);
    return user.active ? [item.owner_user_id] : [];
  }
  return item.owner_team ? activeUserIdsWithRole(item.owner_team, tenant, transaction) : [];
}

/**
 * Reserva a chave do alerta (UNIQUE por empresa): devolve true só para quem reservou primeiro. Sem reserva não há notificação, então
 * o mesmo alerta nunca sai duas vezes, nem com dois processos rodando o job ao mesmo tempo.
 */
async function claimAlert(tenant, { key, type, itemId, recipients }, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.calendar_alert_log (group_id, company_id, alert_key, alert_type, item_id, recipients)
     VALUES (:groupId, :companyId, :key, :type, :itemId, :recipients) ON CONFLICT (company_id, alert_key) DO NOTHING RETURNING id`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, key, type, itemId: itemId || null, recipients } }
  );
  return rows.length > 0;
}

async function notify(tenant, userIds, { title, body }, transaction) {
  for (const userId of userIds) {
    await Notification.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: CHANNEL_IN_APP, title, body, createdBy: null, updatedBy: null }, { transaction });
  }
}

module.exports = { recipientsOf, claimAlert, notify };
